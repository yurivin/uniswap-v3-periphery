import { Fixture } from 'ethereum-waffle'
import { BigNumber, constants, Wallet } from 'ethers'
import { ethers, waffle } from 'hardhat'
import { TestERC20, ISwapRouter, SwapRouter, IUniswapV3Pool } from '../typechain'
import completeFixture from './shared/completeFixture'
import { encodePath } from './shared/path'
import { expect } from './shared/expect'
import { expandTo18Decimals } from './shared/expandTo18Decimals'
import { FeeAmount, TICK_SPACINGS } from './shared/constants'
import { encodePriceSqrt } from './shared/encodePriceSqrt'
import { getMaxTick, getMinTick } from './shared/ticks'

describe('SwapRouter Referrer Integration Tests', () => {
  let wallet: Wallet
  let trader: Wallet
  let referrer: Wallet
  let other: Wallet

  const swapRouterFixture: Fixture<{
    router: SwapRouter
    tokens: [TestERC20, TestERC20, TestERC20]
    pools: [IUniswapV3Pool, IUniswapV3Pool, IUniswapV3Pool]
  }> = async (wallets, provider) => {
    const { router, tokens, pools } = await completeFixture(wallets, provider)
    return {
      router,
      tokens,
      pools,
    }
  }

  let router: SwapRouter
  let tokens: [TestERC20, TestERC20, TestERC20]
  let pools: [IUniswapV3Pool, IUniswapV3Pool, IUniswapV3Pool]
  let loadFixture: ReturnType<typeof waffle.createFixtureLoader>

  before('create fixture loader', async () => {
    ;[wallet, trader, referrer, other] = await (ethers as any).getSigners()
    loadFixture = waffle.createFixtureLoader([wallet, trader, referrer, other])
  })

  beforeEach('load fixture', async () => {
    ;({ router, tokens, pools } = await loadFixture(swapRouterFixture))
    
    // Setup referrer configuration
    await router.setReferrer(referrer.address)
    await router.setReferrerFee(50) // 0.5%
    
    // Give trader some tokens
    await tokens[0].connect(trader).approve(router.address, constants.MaxUint256)
    await tokens[1].connect(trader).approve(router.address, constants.MaxUint256)
    await tokens[2].connect(trader).approve(router.address, constants.MaxUint256)
    
    // Transfer tokens to trader
    const transferAmount = expandTo18Decimals(10000)
    await tokens[0].transfer(trader.address, transferAmount)
    await tokens[1].transfer(trader.address, transferAmount)
    await tokens[2].transfer(trader.address, transferAmount)
  })

  describe('exactInputSingle with Referrer Fee', () => {
    it('deducts referrer fee and accumulates correctly', async () => {
      const inputAmount = expandTo18Decimals(1000)
      const expectedReferrerFee = inputAmount.mul(50).div(10000) // 0.5%
      const adjustedInputAmount = inputAmount.sub(expectedReferrerFee)
      
      const params: ISwapRouter.ExactInputSingleParamsStruct = {
        tokenIn: tokens[0].address,
        tokenOut: tokens[1].address,
        fee: FeeAmount.MEDIUM,
        recipient: trader.address,
        deadline: constants.MaxUint256,
        amountIn: inputAmount,
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0,
      }

      const traderBalanceBefore = await tokens[0].balanceOf(trader.address)
      
      await expect(router.connect(trader).exactInputSingle(params))
        .to.emit(router, 'ReferrerFeeAccumulated')
        .withArgs(referrer.address, tokens[0].address, expectedReferrerFee)

      const traderBalanceAfter = await tokens[0].balanceOf(trader.address)
      const actualDeduction = traderBalanceBefore.sub(traderBalanceAfter)
      
      // Trader should pay the full input amount (including referrer fee)
      expect(actualDeduction).to.eq(inputAmount)
      
      // Referrer fee should be accumulated
      const accumulatedFee = await router.referrerFees(referrer.address, tokens[0].address)
      expect(accumulatedFee).to.eq(expectedReferrerFee)
    })

    it('works correctly when referrer is disabled', async () => {
      await router.setReferrer(constants.AddressZero)
      
      const inputAmount = expandTo18Decimals(1000)
      
      const params: ISwapRouter.ExactInputSingleParamsStruct = {
        tokenIn: tokens[0].address,
        tokenOut: tokens[1].address,
        fee: FeeAmount.MEDIUM,
        recipient: trader.address,
        deadline: constants.MaxUint256,
        amountIn: inputAmount,
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0,
      }

      const traderBalanceBefore = await tokens[0].balanceOf(trader.address)
      
      await router.connect(trader).exactInputSingle(params)

      const traderBalanceAfter = await tokens[0].balanceOf(trader.address)
      const actualDeduction = traderBalanceBefore.sub(traderBalanceAfter)
      
      // Trader should pay exactly the input amount (no referrer fee)
      expect(actualDeduction).to.eq(inputAmount)
      
      // No referrer fee should be accumulated
      const accumulatedFee = await router.referrerFees(referrer.address, tokens[0].address)
      expect(accumulatedFee).to.eq(0)
    })

    it('respects slippage protection with referrer fee adjustment', async () => {
      const inputAmount = expandTo18Decimals(1000)
      const expectedReferrerFee = inputAmount.mul(50).div(10000) // 0.5%
      
      // Set a minimum output that would fail without fee adjustment
      const params: ISwapRouter.ExactInputSingleParamsStruct = {
        tokenIn: tokens[0].address,
        tokenOut: tokens[1].address,
        fee: FeeAmount.MEDIUM,
        recipient: trader.address,
        deadline: constants.MaxUint256,
        amountIn: inputAmount,
        amountOutMinimum: expandTo18Decimals(995), // Very high minimum
        sqrtPriceLimitX96: 0,
      }

      // This should succeed because the slippage protection is adjusted for the referrer fee
      await expect(router.connect(trader).exactInputSingle(params)).to.not.be.reverted
    })
  })

  describe('exactInput (Multi-hop) with Referrer Fee', () => {
    it('deducts referrer fee from initial input token', async () => {
      const inputAmount = expandTo18Decimals(1000)
      const expectedReferrerFee = inputAmount.mul(50).div(10000) // 0.5%
      
      const path = encodePath([tokens[0].address, tokens[1].address, tokens[2].address], [FeeAmount.MEDIUM, FeeAmount.MEDIUM])
      
      const params: ISwapRouter.ExactInputParamsStruct = {
        path: path,
        recipient: trader.address,
        deadline: constants.MaxUint256,
        amountIn: inputAmount,
        amountOutMinimum: 0,
      }

      const traderBalanceBefore = await tokens[0].balanceOf(trader.address)
      
      await expect(router.connect(trader).exactInput(params))
        .to.emit(router, 'ReferrerFeeAccumulated')
        .withArgs(referrer.address, tokens[0].address, expectedReferrerFee)

      const traderBalanceAfter = await tokens[0].balanceOf(trader.address)
      const actualDeduction = traderBalanceBefore.sub(traderBalanceAfter)
      
      // Trader should pay the full input amount
      expect(actualDeduction).to.eq(inputAmount)
      
      // Referrer fee should be accumulated
      const accumulatedFee = await router.referrerFees(referrer.address, tokens[0].address)
      expect(accumulatedFee).to.eq(expectedReferrerFee)
    })
  })

  describe('exactOutputSingle with Referrer Fee', () => {
    it('adds referrer fee to total amount required', async () => {
      const outputAmount = expandTo18Decimals(500)
      
      const params: ISwapRouter.ExactOutputSingleParamsStruct = {
        tokenIn: tokens[0].address,
        tokenOut: tokens[1].address,
        fee: FeeAmount.MEDIUM,
        recipient: trader.address,
        deadline: constants.MaxUint256,
        amountOut: outputAmount,
        amountInMaximum: constants.MaxUint256,
        sqrtPriceLimitX96: 0,
      }

      const traderBalanceBefore = await tokens[0].balanceOf(trader.address)
      
      const amountIn = await router.connect(trader).callStatic.exactOutputSingle(params)
      await router.connect(trader).exactOutputSingle(params)

      const traderBalanceAfter = await tokens[0].balanceOf(trader.address)
      const actualDeduction = traderBalanceBefore.sub(traderBalanceAfter)
      
      // The returned amountIn should include the referrer fee
      expect(actualDeduction).to.eq(amountIn)
      
      // Calculate expected referrer fee from the base swap amount
      const baseSwapAmount = amountIn.mul(10000).div(10050) // Reverse calculate base amount
      const expectedReferrerFee = baseSwapAmount.mul(50).div(10000)
      
      // Referrer fee should be accumulated (approximately, due to rounding)
      const accumulatedFee = await router.referrerFees(referrer.address, tokens[0].address)
      expect(accumulatedFee).to.be.closeTo(expectedReferrerFee, expandTo18Decimals(1))
    })
  })

  describe('Fee Collection', () => {
    beforeEach(async () => {
      // Perform a swap to accumulate some fees
      const inputAmount = expandTo18Decimals(1000)
      
      const params: ISwapRouter.ExactInputSingleParamsStruct = {
        tokenIn: tokens[0].address,
        tokenOut: tokens[1].address,
        fee: FeeAmount.MEDIUM,
        recipient: trader.address,
        deadline: constants.MaxUint256,
        amountIn: inputAmount,
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0,
      }

      await router.connect(trader).exactInputSingle(params)
    })

    it('referrer can collect accumulated fees', async () => {
      const accumulatedBefore = await router.referrerFees(referrer.address, tokens[0].address)
      expect(accumulatedBefore).to.be.gt(0)
      
      const referrerBalanceBefore = await tokens[0].balanceOf(referrer.address)
      
      await expect(router.connect(referrer).collectReferrerFees(tokens[0].address))
        .to.emit(router, 'ReferrerFeesCollected')
        .withArgs(referrer.address, tokens[0].address, accumulatedBefore)
      
      const referrerBalanceAfter = await tokens[0].balanceOf(referrer.address)
      const collected = referrerBalanceAfter.sub(referrerBalanceBefore)
      
      expect(collected).to.eq(accumulatedBefore)
      
      // Accumulated fees should be reset to zero
      const accumulatedAfter = await router.referrerFees(referrer.address, tokens[0].address)
      expect(accumulatedAfter).to.eq(0)
    })

    it('prevents double collection', async () => {
      await router.connect(referrer).collectReferrerFees(tokens[0].address)
      
      // Second collection should fail
      await expect(router.connect(referrer).collectReferrerFees(tokens[0].address))
        .to.be.revertedWith('No fees to collect')
    })

    it('allows collection of multiple tokens', async () => {
      // Perform another swap with different tokens to accumulate fees
      const inputAmount = expandTo18Decimals(500)
      
      const params: ISwapRouter.ExactInputSingleParamsStruct = {
        tokenIn: tokens[1].address,
        tokenOut: tokens[0].address,
        fee: FeeAmount.MEDIUM,
        recipient: trader.address,
        deadline: constants.MaxUint256,
        amountIn: inputAmount,
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0,
      }

      await router.connect(trader).exactInputSingle(params)
      
      const tokenAddresses = [tokens[0].address, tokens[1].address]
      const amounts = await router.connect(referrer).callStatic.collectReferrerFeesMultiple(tokenAddresses)
      
      expect(amounts[0]).to.be.gt(0) // tokens[0] fees
      expect(amounts[1]).to.be.gt(0) // tokens[1] fees
      
      await router.connect(referrer).collectReferrerFeesMultiple(tokenAddresses)
      
      // Both balances should be reset
      expect(await router.referrerFees(referrer.address, tokens[0].address)).to.eq(0)
      expect(await router.referrerFees(referrer.address, tokens[1].address)).to.eq(0)
    })
  })

  describe('Different Fee Rates', () => {
    const testFeeRates = [10, 50, 100, 250, 500] // 0.1%, 0.5%, 1%, 2.5%, 5%
    
    testFeeRates.forEach((feeRate) => {
      it(`works correctly with ${feeRate / 100}% fee rate`, async () => {
        await router.setReferrerFee(feeRate)
        
        const inputAmount = expandTo18Decimals(1000)
        const expectedReferrerFee = inputAmount.mul(feeRate).div(10000)
        
        const params: ISwapRouter.ExactInputSingleParamsStruct = {
          tokenIn: tokens[0].address,
          tokenOut: tokens[1].address,
          fee: FeeAmount.MEDIUM,
          recipient: trader.address,
          deadline: constants.MaxUint256,
          amountIn: inputAmount,
          amountOutMinimum: 0,
          sqrtPriceLimitX96: 0,
        }

        await router.connect(trader).exactInputSingle(params)
        
        const accumulatedFee = await router.referrerFees(referrer.address, tokens[0].address)
        expect(accumulatedFee).to.eq(expectedReferrerFee)
      })
    })
  })

  describe('Edge Cases and Error Conditions', () => {
    it('handles very small swap amounts', async () => {
      const inputAmount = BigNumber.from(100) // Very small amount
      
      const params: ISwapRouter.ExactInputSingleParamsStruct = {
        tokenIn: tokens[0].address,
        tokenOut: tokens[1].address,
        fee: FeeAmount.MEDIUM,
        recipient: trader.address,
        deadline: constants.MaxUint256,
        amountIn: inputAmount,
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0,
      }

      // Should not revert even with very small amounts
      await expect(router.connect(trader).exactInputSingle(params)).to.not.be.reverted
    })

    it('handles insufficient allowance correctly', async () => {
      await tokens[0].connect(trader).approve(router.address, 0)
      
      const params: ISwapRouter.ExactInputSingleParamsStruct = {
        tokenIn: tokens[0].address,
        tokenOut: tokens[1].address,
        fee: FeeAmount.MEDIUM,
        recipient: trader.address,
        deadline: constants.MaxUint256,
        amountIn: expandTo18Decimals(1000),
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0,
      }

      await expect(router.connect(trader).exactInputSingle(params))
        .to.be.revertedWith('ERC20: transfer amount exceeds allowance')
    })

    it('handles insufficient balance correctly', async () => {
      const hugeAmount = expandTo18Decimals(1000000) // More than trader has
      
      const params: ISwapRouter.ExactInputSingleParamsStruct = {
        tokenIn: tokens[0].address,
        tokenOut: tokens[1].address,
        fee: FeeAmount.MEDIUM,
        recipient: trader.address,
        deadline: constants.MaxUint256,
        amountIn: hugeAmount,
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0,
      }

      await expect(router.connect(trader).exactInputSingle(params))
        .to.be.revertedWith('ERC20: transfer amount exceeds balance')
    })
  })
})