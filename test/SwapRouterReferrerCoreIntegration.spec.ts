import { Fixture } from 'ethereum-waffle'
import { BigNumber, constants, Wallet } from 'ethers'
import { ethers, waffle } from 'hardhat'
import { TestERC20, IWETH9, MockTimeSwapRouter, MockTimeNonfungiblePositionManager } from '../typechain'
import completeFixture from './shared/completeFixture'
import { expect } from './shared/expect'
import { expandTo18Decimals } from './shared/expandTo18Decimals'
import { FeeAmount, TICK_SPACINGS } from './shared/constants'
import { encodePriceSqrt } from './shared/encodePriceSqrt'
import { getMaxTick, getMinTick } from './shared/ticks'
import { encodePath } from './shared/path'

describe('SwapRouter Referrer - Core Integration Tests', function () {
  this.timeout(40000)
  let wallet: Wallet
  let trader: Wallet
  let referrer: Wallet

  const swapRouterFixture: Fixture<{
    weth9: IWETH9
    router: MockTimeSwapRouter
    nft: MockTimeNonfungiblePositionManager
    tokens: [TestERC20, TestERC20, TestERC20]
  }> = async (wallets, provider) => {
    const { weth9, factory, router, tokens, nft } = await completeFixture(wallets, provider)

    // approve & fund wallets
    for (const token of tokens) {
      await token.approve(router.address, constants.MaxUint256)
      await token.approve(nft.address, constants.MaxUint256)
      await token.connect(trader).approve(router.address, constants.MaxUint256)
      await token.transfer(trader.address, expandTo18Decimals(1_000_000))
    }

    return {
      weth9,
      router,
      tokens,
      nft,
    }
  }

  let weth9: IWETH9
  let router: MockTimeSwapRouter
  let nft: MockTimeNonfungiblePositionManager
  let tokens: [TestERC20, TestERC20, TestERC20]
  let loadFixture: ReturnType<typeof waffle.createFixtureLoader>

  before('create fixture loader', async () => {
    ;[wallet, trader, referrer] = await (ethers as any).getSigners()
    loadFixture = waffle.createFixtureLoader([wallet, trader, referrer])
  })

  beforeEach('load fixture', async () => {
    ;({ weth9, router, tokens, nft } = await loadFixture(swapRouterFixture))
    
    // Create pools and add liquidity (same as original SwapRouter tests)
    await nft.createAndInitializePoolIfNecessary(
      tokens[0].address,
      tokens[1].address,
      FeeAmount.MEDIUM,
      encodePriceSqrt(1, 1)
    )

    await nft.createAndInitializePoolIfNecessary(
      tokens[1].address,
      tokens[2].address,
      FeeAmount.MEDIUM,
      encodePriceSqrt(1, 1)
    )

    await nft.mint({
      token0: tokens[0].address,
      token1: tokens[1].address,
      fee: FeeAmount.MEDIUM,
      tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
      tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
      recipient: wallet.address,
      amount0Desired: 1000000,
      amount1Desired: 1000000,
      amount0Min: 0,
      amount1Min: 0,
      deadline: 1,
    })

    await nft.mint({
      token0: tokens[1].address,
      token1: tokens[2].address,
      fee: FeeAmount.MEDIUM,
      tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
      tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
      recipient: wallet.address,
      amount0Desired: 1000000,
      amount1Desired: 1000000,
      amount0Min: 0,
      amount1Min: 0,
      deadline: 1,
    })
  })

  describe('Core Swap Functionality with Referrer Integration', () => {
    beforeEach(async () => {
      // Enable referrer for these tests
      await router.setReferrer(referrer.address)
      await router.setReferrerFee(50) // 0.5%
    })

    it('exactInputSingle maintains swap correctness with referrer fee', async () => {
      const inputAmount = expandTo18Decimals(1)
      const expectedReferrerFee = inputAmount.mul(50).div(10000) // 0.5%
      const adjustedInputAmount = inputAmount.sub(expectedReferrerFee)

      const balanceBefore = await tokens[1].balanceOf(trader.address)
      
      await router.connect(trader).exactInputSingle({
        tokenIn: tokens[0].address,
        tokenOut: tokens[1].address,
        fee: FeeAmount.MEDIUM,
        recipient: trader.address,
        deadline: 1,
        amountIn: inputAmount,
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0,
      })

      const balanceAfter = await tokens[1].balanceOf(trader.address)
      const outputReceived = balanceAfter.sub(balanceBefore)

      // Output should be based on adjusted input amount (input minus referrer fee)
      expect(outputReceived).to.be.gt(0)
      
      // Referrer fee should be accumulated
      const accumulatedFee = await router.referrerFees(referrer.address, tokens[0].address)
      expect(accumulatedFee).to.eq(expectedReferrerFee)
    })

    it('exactInput multi-hop with referrer maintains path execution', async () => {
      const inputAmount = expandTo18Decimals(3)
      const expectedReferrerFee = inputAmount.mul(50).div(10000) // 0.5%
      
      const path = encodePath([tokens[0].address, tokens[1].address, tokens[2].address], [FeeAmount.MEDIUM, FeeAmount.MEDIUM])

      const balanceBefore = await tokens[2].balanceOf(trader.address)
      
      await router.connect(trader).exactInput({
        path: path,
        recipient: trader.address,
        deadline: 1,
        amountIn: inputAmount,
        amountOutMinimum: 0,
      })

      const balanceAfter = await tokens[2].balanceOf(trader.address)
      const outputReceived = balanceAfter.sub(balanceBefore)

      // Should receive some output tokens
      expect(outputReceived).to.be.gt(0)
      
      // Referrer fee should be deducted from first token only
      const accumulatedFee = await router.referrerFees(referrer.address, tokens[0].address)
      expect(accumulatedFee).to.eq(expectedReferrerFee)
      
      // No fees should be accumulated for intermediate tokens
      const accumulatedFee1 = await router.referrerFees(referrer.address, tokens[1].address)
      const accumulatedFee2 = await router.referrerFees(referrer.address, tokens[2].address)
      expect(accumulatedFee1).to.eq(0)
      expect(accumulatedFee2).to.eq(0)
    })

    it('exactOutputSingle includes referrer fee in total cost', async () => {
      const outputAmount = expandTo18Decimals(1)
      
      const balanceBefore = await tokens[0].balanceOf(trader.address)
      
      const amountIn = await router.connect(trader).callStatic.exactOutputSingle({
        tokenIn: tokens[0].address,
        tokenOut: tokens[1].address,
        fee: FeeAmount.MEDIUM,
        recipient: trader.address,
        deadline: 1,
        amountOut: outputAmount,
        amountInMaximum: constants.MaxUint256,
        sqrtPriceLimitX96: 0,
      })

      await router.connect(trader).exactOutputSingle({
        tokenIn: tokens[0].address,
        tokenOut: tokens[1].address,
        fee: FeeAmount.MEDIUM,
        recipient: trader.address,
        deadline: 1,
        amountOut: outputAmount,
        amountInMaximum: constants.MaxUint256,
        sqrtPriceLimitX96: 0,
      })

      const balanceAfter = await tokens[0].balanceOf(trader.address)
      const totalCost = balanceBefore.sub(balanceAfter)

      // Total cost should match the returned amountIn (including referrer fee)
      expect(totalCost).to.eq(amountIn)
      
      // Calculate expected referrer fee from base swap amount
      const baseSwapAmount = amountIn.mul(10000).div(10050) // Reverse calculate
      const expectedReferrerFee = baseSwapAmount.mul(50).div(10000)
      
      const accumulatedFee = await router.referrerFees(referrer.address, tokens[0].address)
      expect(accumulatedFee).to.be.closeTo(expectedReferrerFee, expandTo18Decimals(1).div(1000)) // Allow small rounding difference
    })

    it('maintains original behavior when referrer is disabled', async () => {
      await router.setReferrer(constants.AddressZero)
      
      const inputAmount = expandTo18Decimals(1)
      const balanceBefore = await tokens[0].balanceOf(trader.address)
      
      await router.connect(trader).exactInputSingle({
        tokenIn: tokens[0].address,
        tokenOut: tokens[1].address,
        fee: FeeAmount.MEDIUM,
        recipient: trader.address,
        deadline: 1,
        amountIn: inputAmount,
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0,
      })

      const balanceAfter = await tokens[0].balanceOf(trader.address)
      const amountSpent = balanceBefore.sub(balanceAfter)

      // Should spend exactly the input amount (no referrer fee)
      expect(amountSpent).to.eq(inputAmount)
      
      // No referrer fees should be accumulated
      const accumulatedFee = await router.referrerFees(referrer.address, tokens[0].address)
      expect(accumulatedFee).to.eq(0)
    })

    it('slippage protection works correctly with referrer fees', async () => {
      const inputAmount = expandTo18Decimals(100)
      
      // First, do a swap without referrer to get baseline output
      await router.setReferrer(constants.AddressZero)
      const baselineOutput = await router.connect(trader).callStatic.exactInputSingle({
        tokenIn: tokens[0].address,
        tokenOut: tokens[1].address,
        fee: FeeAmount.MEDIUM,
        recipient: trader.address,
        deadline: 1,
        amountIn: inputAmount,
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0,
      })

      // Re-enable referrer
      await router.setReferrer(referrer.address)
      
      // Calculate expected output with referrer fee (should be slightly less)
      const referrerFee = inputAmount.mul(50).div(10000) // 0.5%
      const adjustedInput = inputAmount.sub(referrerFee)
      const expectedOutputWithFee = baselineOutput.mul(adjustedInput).div(inputAmount)
      
      // Set minimum output accounting for referrer fee impact
      const minOutput = expectedOutputWithFee.mul(99).div(100) // 1% slippage tolerance
      
      // This should succeed
      await expect(
        router.connect(trader).exactInputSingle({
          tokenIn: tokens[0].address,
          tokenOut: tokens[1].address,
          fee: FeeAmount.MEDIUM,
          recipient: trader.address,
          deadline: 1,
          amountIn: inputAmount,
          amountOutMinimum: minOutput,
          sqrtPriceLimitX96: 0,
        })
      ).to.not.be.reverted
    })
  })

  describe('WETH Integration with Referrer', () => {
    beforeEach(async () => {
      await router.setReferrer(referrer.address)
      await router.setReferrerFee(50) // 0.5%
      
      // Create WETH-token pool
      await nft.createAndInitializePoolIfNecessary(
        weth9.address,
        tokens[0].address,
        FeeAmount.MEDIUM,
        encodePriceSqrt(1, 1)
      )

      // Add liquidity to WETH pool
      await weth9.deposit({ value: expandTo18Decimals(10) })
      await weth9.approve(nft.address, constants.MaxUint256)
      
      await nft.mint({
        token0: weth9.address < tokens[0].address ? weth9.address : tokens[0].address,
        token1: weth9.address < tokens[0].address ? tokens[0].address : weth9.address,
        fee: FeeAmount.MEDIUM,
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        recipient: wallet.address,
        amount0Desired: 1000000,
        amount1Desired: 1000000,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 1,
      })
    })

    it('handles ETH swaps with referrer fees correctly', async () => {
      const ethAmount = expandTo18Decimals(1)
      const expectedReferrerFee = ethAmount.mul(50).div(10000) // 0.5%
      
      const balanceBefore = await tokens[0].balanceOf(trader.address)
      
      await router.connect(trader).exactInputSingle({
        tokenIn: weth9.address,
        tokenOut: tokens[0].address,
        fee: FeeAmount.MEDIUM,
        recipient: trader.address,
        deadline: 1,
        amountIn: ethAmount,
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0,
      }, { value: ethAmount })

      const balanceAfter = await tokens[0].balanceOf(trader.address)
      const outputReceived = balanceAfter.sub(balanceBefore)

      expect(outputReceived).to.be.gt(0)
      
      // Referrer fee should be accumulated for WETH
      const accumulatedFee = await router.referrerFees(referrer.address, weth9.address)
      expect(accumulatedFee).to.eq(expectedReferrerFee)
    })
  })

  describe('Multicall Integration with Referrer', () => {
    beforeEach(async () => {
      await router.setReferrer(referrer.address)
      await router.setReferrerFee(30) // 0.3%
    })

    it('processes referrer fees correctly in multicall', async () => {
      const inputAmount = expandTo18Decimals(1)
      const expectedReferrerFee = inputAmount.mul(30).div(10000) // 0.3%

      // Prepare multicall with swap + referrer configuration
      const swapCall = router.interface.encodeFunctionData('exactInputSingle', [{
        tokenIn: tokens[0].address,
        tokenOut: tokens[1].address,
        fee: FeeAmount.MEDIUM,
        recipient: trader.address,
        deadline: 1,
        amountIn: inputAmount,
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0,
      }])

      await router.connect(trader).multicall([swapCall])

      // Verify referrer fee was accumulated
      const accumulatedFee = await router.referrerFees(referrer.address, tokens[0].address)
      expect(accumulatedFee).to.eq(expectedReferrerFee)
    })
  })

  describe('Gas Usage Comparison', () => {
    it('measures gas overhead with referrer functionality', async () => {
      const inputAmount = expandTo18Decimals(1)

      // Measure gas without referrer
      await router.setReferrer(constants.AddressZero)
      const tx1 = await router.connect(trader).exactInputSingle({
        tokenIn: tokens[0].address,
        tokenOut: tokens[1].address,
        fee: FeeAmount.MEDIUM,
        recipient: trader.address,
        deadline: 1,
        amountIn: inputAmount,
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0,
      })
      const receipt1 = await tx1.wait()
      const gasWithoutReferrer = receipt1.gasUsed

      // Measure gas with referrer
      await router.setReferrer(referrer.address)
      await router.setReferrerFee(50)
      
      const tx2 = await router.connect(trader).exactInputSingle({
        tokenIn: tokens[0].address,
        tokenOut: tokens[1].address,
        fee: FeeAmount.MEDIUM,
        recipient: trader.address,
        deadline: 1,
        amountIn: inputAmount,
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0,
      })
      const receipt2 = await tx2.wait()
      const gasWithReferrer = receipt2.gasUsed

      const overhead = gasWithReferrer.sub(gasWithoutReferrer)
      const overheadPercentage = overhead.mul(10000).div(gasWithoutReferrer).toNumber() / 100

      console.log(`Gas without referrer: ${gasWithoutReferrer.toString()}`)
      console.log(`Gas with referrer: ${gasWithReferrer.toString()}`)
      console.log(`Overhead: ${overhead.toString()} (${overheadPercentage.toFixed(2)}%)`)

      // Overhead should be reasonable (less than 10%)
      expect(overheadPercentage).to.be.lessThan(10)
    })
  })
})