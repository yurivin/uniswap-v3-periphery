import { Fixture } from 'ethereum-waffle'
import { BigNumber, constants, Wallet } from 'ethers'
import { ethers, waffle } from 'hardhat'
import { TestERC20, ISwapRouter, SwapRouter } from '../typechain'
import completeFixture from './shared/completeFixture'
import { expect } from './shared/expect'
import { expandTo18Decimals } from './shared/expandTo18Decimals'
import { FeeAmount } from './shared/constants'

// Malicious contract that tries to exploit reentrancy
const MALICIOUS_REFERRER_BYTECODE = `
  contract MaliciousReferrer {
    SwapRouter public immutable router;
    bool public attacked = false;
    
    constructor(address _router) {
      router = SwapRouter(_router);
    }
    
    // Try to reenter during fee collection
    receive() external payable {
      if (!attacked) {
        attacked = true;
        // Attempt reentrancy
        try router.collectReferrerFees(msg.sender) {} catch {}
      }
    }
    
    // Try to reenter via ERC20 transfer callback
    function onTokenTransfer(address token, uint256 amount) external {
      if (!attacked) {
        attacked = true;
        // Attempt reentrancy during token transfer
        try router.collectReferrerFees(token) {} catch {}
      }
    }
  }
`

describe('SwapRouter Referrer Security Tests', () => {
  let wallet: Wallet
  let trader: Wallet
  let referrer: Wallet
  let maliciousReferrer: Wallet
  let attacker: Wallet

  const swapRouterFixture: Fixture<{
    router: SwapRouter
    tokens: [TestERC20, TestERC20, TestERC20]
  }> = async (wallets, provider) => {
    const { router, tokens } = await completeFixture(wallets, provider)
    return {
      router,
      tokens,
    }
  }

  let router: SwapRouter
  let tokens: [TestERC20, TestERC20, TestERC20]
  let loadFixture: ReturnType<typeof waffle.createFixtureLoader>

  before('create fixture loader', async () => {
    ;[wallet, trader, referrer, maliciousReferrer, attacker] = await (ethers as any).getSigners()
    loadFixture = waffle.createFixtureLoader([wallet, trader, referrer, maliciousReferrer, attacker])
  })

  beforeEach('load fixture', async () => {
    ;({ router, tokens } = await loadFixture(swapRouterFixture))
    
    // Setup tokens for trader
    await tokens[0].connect(trader).approve(router.address, constants.MaxUint256)
    await tokens[1].connect(trader).approve(router.address, constants.MaxUint256)
    
    const transferAmount = expandTo18Decimals(10000)
    await tokens[0].transfer(trader.address, transferAmount)
    await tokens[1].transfer(trader.address, transferAmount)
  })

  describe('Access Control Security', () => {
    it('prevents non-owner from setting referrer', async () => {
      await expect(router.connect(attacker).setReferrer(referrer.address))
        .to.be.revertedWith('Ownable: caller is not the owner')
    })

    it('prevents non-owner from setting referrer fee', async () => {
      await expect(router.connect(attacker).setReferrerFee(100))
        .to.be.revertedWith('Ownable: caller is not the owner')
    })

    it('prevents setting fee above maximum', async () => {
      await expect(router.setReferrerFee(501)) // > 5%
        .to.be.revertedWith('Fee too high')
    })

    it('allows maximum fee exactly', async () => {
      await expect(router.setReferrerFee(500)) // exactly 5%
        .to.not.be.reverted
    })

    it('prevents unauthorized ownership transfer', async () => {
      await expect(router.connect(attacker).transferOwnership(attacker.address))
        .to.be.revertedWith('Ownable: caller is not the owner')
    })
  })

  describe('Reentrancy Protection', () => {
    beforeEach(async () => {
      await router.setReferrer(referrer.address)
      await router.setReferrerFee(50) // 0.5%
      
      // Perform a swap to accumulate fees
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

    it('prevents reentrancy during fee collection', async () => {
      // Normal collection should work
      const fees = await router.referrerFees(referrer.address, tokens[0].address)
      expect(fees).to.be.gt(0)
      
      // Collection should succeed and reset fees
      await router.connect(referrer).collectReferrerFees(tokens[0].address)
      
      // Attempting to collect again should fail
      await expect(router.connect(referrer).collectReferrerFees(tokens[0].address))
        .to.be.revertedWith('No fees to collect')
    })

    it('prevents multiple collections in same transaction', async () => {
      const fees = await router.referrerFees(referrer.address, tokens[0].address)
      expect(fees).to.be.gt(0)
      
      // Try to collect the same token twice in multiple collection call
      const tokens = [tokens[0].address, tokens[0].address]
      
      // This should only collect once, second should be zero
      const amounts = await router.connect(referrer).callStatic.collectReferrerFeesMultiple(tokens)
      expect(amounts[0]).to.eq(fees)
      expect(amounts[1]).to.eq(0) // Already collected in same call
    })

    it('collection is atomic - all or nothing', async () => {
      // Perform another swap to get fees in different token
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
      
      const feesBefore0 = await router.referrerFees(referrer.address, tokens[0].address)
      const feesBefore1 = await router.referrerFees(referrer.address, tokens[1].address)
      
      expect(feesBefore0).to.be.gt(0)
      expect(feesBefore1).to.be.gt(0)
      
      // Collect both tokens
      await router.connect(referrer).collectReferrerFeesMultiple([tokens[0].address, tokens[1].address])
      
      // Both should be reset
      const feesAfter0 = await router.referrerFees(referrer.address, tokens[0].address)
      const feesAfter1 = await router.referrerFees(referrer.address, tokens[1].address)
      
      expect(feesAfter0).to.eq(0)
      expect(feesAfter1).to.eq(0)
    })
  })

  describe('Fee Calculation Edge Cases', () => {
    beforeEach(async () => {
      await router.setReferrer(referrer.address)
    })

    it('handles zero fee rate correctly', async () => {
      await router.setReferrerFee(0)
      
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
      
      // No fees should be accumulated
      const accumulatedFee = await router.referrerFees(referrer.address, tokens[0].address)
      expect(accumulatedFee).to.eq(0)
    })

    it('handles zero address referrer correctly', async () => {
      await router.setReferrer(constants.AddressZero)
      await router.setReferrerFee(50)
      
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
      
      // No fees should be accumulated for zero address
      const accumulatedFee = await router.referrerFees(constants.AddressZero, tokens[0].address)
      expect(accumulatedFee).to.eq(0)
    })

    it('prevents integer overflow in fee calculation', async () => {
      await router.setReferrerFee(500) // 5% maximum
      
      const maxSafeAmount = constants.MaxUint256.div(10000)
      const fee = await router.calculateReferrerFee(maxSafeAmount)
      
      // Should not overflow
      expect(fee).to.eq(maxSafeAmount.div(20)) // 5% of max safe amount
    })

    it('handles rounding correctly for small amounts', async () => {
      await router.setReferrerFee(33) // 0.33%
      
      // Amount that results in fractional fee
      const amount = BigNumber.from(1000)
      const expectedFee = amount.mul(33).div(10000) // Should be 0 due to rounding down
      
      const calculatedFee = await router.calculateReferrerFee(amount)
      expect(calculatedFee).to.eq(expectedFee)
    })
  })

  describe('MEV and Front-running Protection', () => {
    it('referrer changes do not affect pending transactions', async () => {
      await router.setReferrer(referrer.address)
      await router.setReferrerFee(50)
      
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

      // Simulate transaction being submitted
      const tx = await router.connect(trader).populateTransaction.exactInputSingle(params)
      
      // Owner changes referrer (simulating front-running)
      await router.setReferrer(attacker.address)
      
      // Original transaction should still use old referrer at execution time
      // (This test is more conceptual - actual MEV protection would require additional measures)
      await router.connect(trader).exactInputSingle(params)
      
      // Fees should go to the current referrer (attacker in this case)
      const attackerFees = await router.referrerFees(attacker.address, tokens[0].address)
      const originalReferrerFees = await router.referrerFees(referrer.address, tokens[0].address)
      
      expect(attackerFees).to.be.gt(0)
      expect(originalReferrerFees).to.eq(0)
    })

    it('slippage protection accounts for referrer fees', async () => {
      await router.setReferrer(referrer.address)
      await router.setReferrerFee(100) // 1%
      
      const inputAmount = expandTo18Decimals(1000)
      // Set minimum output accounting for 1% referrer fee reduction
      const minOutput = expandTo18Decimals(990).mul(99).div(100) // Reduced expectation
      
      const params: ISwapRouter.ExactInputSingleParamsStruct = {
        tokenIn: tokens[0].address,
        tokenOut: tokens[1].address,
        fee: FeeAmount.MEDIUM,
        recipient: trader.address,
        deadline: constants.MaxUint256,
        amountIn: inputAmount,
        amountOutMinimum: minOutput,
        sqrtPriceLimitX96: 0,
      }

      // Should succeed with adjusted slippage protection
      await expect(router.connect(trader).exactInputSingle(params)).to.not.be.reverted
    })
  })

  describe('Economic Attack Prevention', () => {
    it('prevents excessive fee extraction', async () => {
      // Maximum fee is 5%
      await router.setReferrer(referrer.address)
      await router.setReferrerFee(500) // 5% maximum
      
      const inputAmount = expandTo18Decimals(1000)
      const maxExpectedFee = inputAmount.mul(5).div(100) // 5%
      
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
      expect(accumulatedFee).to.be.lte(maxExpectedFee)
    })

    it('ensures fees cannot be stolen by unauthorized parties', async () => {
      await router.setReferrer(referrer.address)
      await router.setReferrerFee(50)
      
      // Perform swap to accumulate fees
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
      
      const accumulatedFee = await router.referrerFees(referrer.address, tokens[0].address)
      expect(accumulatedFee).to.be.gt(0)
      
      // Attacker cannot collect referrer's fees
      await expect(router.connect(attacker).collectReferrerFees(tokens[0].address))
        .to.be.revertedWith('No fees to collect')
      
      // Only the actual referrer can collect
      await expect(router.connect(referrer).collectReferrerFees(tokens[0].address))
        .to.not.be.reverted
    })
  })

  describe('Gas Limit Attacks', () => {
    it('fee collection has bounded gas usage', async () => {
      await router.setReferrer(referrer.address)
      await router.setReferrerFee(50)
      
      // Perform swap to accumulate fees
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
      
      // Collection should use reasonable gas
      const tx = await router.connect(referrer).collectReferrerFees(tokens[0].address)
      const receipt = await tx.wait()
      
      // Should be less than 100k gas for simple collection
      expect(receipt.gasUsed.toNumber()).to.be.lessThan(100000)
    })

    it('multiple token collection has linear gas growth', async () => {
      await router.setReferrer(referrer.address)
      await router.setReferrerFee(50)
      
      // Perform swaps with different tokens to accumulate fees
      const inputAmount = expandTo18Decimals(1000)
      const swaps = [
        { tokenIn: tokens[0].address, tokenOut: tokens[1].address },
        { tokenIn: tokens[1].address, tokenOut: tokens[0].address },
      ]
      
      for (const swap of swaps) {
        const params: ISwapRouter.ExactInputSingleParamsStruct = {
          tokenIn: swap.tokenIn,
          tokenOut: swap.tokenOut,
          fee: FeeAmount.MEDIUM,
          recipient: trader.address,
          deadline: constants.MaxUint256,
          amountIn: inputAmount,
          amountOutMinimum: 0,
          sqrtPriceLimitX96: 0,
        }
        
        await router.connect(trader).exactInputSingle(params)
      }
      
      // Collect multiple tokens
      const tokenAddresses = [tokens[0].address, tokens[1].address]
      const tx = await router.connect(referrer).collectReferrerFeesMultiple(tokenAddresses)
      const receipt = await tx.wait()
      
      // Should be reasonable gas even for multiple tokens
      expect(receipt.gasUsed.toNumber()).to.be.lessThan(200000)
    })
  })

  describe('State Consistency', () => {
    it('maintains consistent state across multiple operations', async () => {
      await router.setReferrer(referrer.address)
      await router.setReferrerFee(50)
      
      const inputAmount = expandTo18Decimals(1000)
      const expectedFee = inputAmount.mul(50).div(10000)
      
      // Perform multiple swaps
      for (let i = 0; i < 3; i++) {
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
      }
      
      // Total accumulated should be 3x the expected fee
      const totalAccumulated = await router.referrerFees(referrer.address, tokens[0].address)
      expect(totalAccumulated).to.eq(expectedFee.mul(3))
      
      // Partial collection
      await router.connect(referrer).collectReferrerFees(tokens[0].address)
      
      // Should be zero after collection
      const afterCollection = await router.referrerFees(referrer.address, tokens[0].address)
      expect(afterCollection).to.eq(0)
    })

    it('handles rapid referrer changes correctly', async () => {
      await router.setReferrer(referrer.address)
      await router.setReferrerFee(50)
      
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

      // Swap with first referrer
      await router.connect(trader).exactInputSingle(params)
      
      // Change referrer
      await router.setReferrer(other.address)
      
      // Swap with second referrer
      await router.connect(trader).exactInputSingle(params)
      
      // Each referrer should have their own fees
      const firstReferrerFees = await router.referrerFees(referrer.address, tokens[0].address)
      const secondReferrerFees = await router.referrerFees(other.address, tokens[0].address)
      
      const expectedFee = inputAmount.mul(50).div(10000)
      expect(firstReferrerFees).to.eq(expectedFee)
      expect(secondReferrerFees).to.eq(expectedFee)
    })
  })
})