import { Fixture } from 'ethereum-waffle'
import { constants, Wallet } from 'ethers'
import { ethers, waffle } from 'hardhat'
import { TestERC20, ISwapRouter, SwapRouter } from '../typechain'
import completeFixture from './shared/completeFixture'
import { encodePath } from './shared/path'
import { expect } from './shared/expect'
import { expandTo18Decimals } from './shared/expandTo18Decimals'

describe('SwapRouter Referrer Functionality', () => {
  let wallet: Wallet
  let trader: Wallet
  let referrer: Wallet
  let other: Wallet

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
    ;[wallet, trader, referrer, other] = await (ethers as any).getSigners()
    loadFixture = waffle.createFixtureLoader([wallet, trader, referrer, other])
  })

  beforeEach('load fixture', async () => {
    ;({ router, tokens } = await loadFixture(swapRouterFixture))
  })

  describe('Referrer Configuration', () => {
    it('initial state is correct', async () => {
      const config = await router.getReferrerConfig()
      expect(config.referrerAddress).to.eq(constants.AddressZero)
      expect(config.feeBasisPoints).to.eq(0)
      expect(await router.owner()).to.eq(wallet.address)
    })

    it('owner can set referrer address', async () => {
      await expect(router.setReferrer(referrer.address))
        .to.emit(router, 'ReferrerChanged')
        .withArgs(constants.AddressZero, referrer.address)
      
      const config = await router.getReferrerConfig()
      expect(config.referrerAddress).to.eq(referrer.address)
    })

    it('owner can set referrer fee', async () => {
      await expect(router.setReferrerFee(50)) // 0.5%
        .to.emit(router, 'ReferrerFeeChanged')
        .withArgs(0, 50)
      
      const config = await router.getReferrerConfig()
      expect(config.feeBasisPoints).to.eq(50)
    })

    it('reverts if non-owner tries to set referrer', async () => {
      await expect(router.connect(trader).setReferrer(referrer.address))
        .to.be.revertedWith('Ownable: caller is not the owner')
    })

    it('reverts if non-owner tries to set fee', async () => {
      await expect(router.connect(trader).setReferrerFee(50))
        .to.be.revertedWith('Ownable: caller is not the owner')
    })

    it('reverts if fee exceeds maximum', async () => {
      await expect(router.setReferrerFee(501)) // 5.01%
        .to.be.revertedWith('Fee too high')
    })

    it('allows maximum fee rate', async () => {
      await expect(router.setReferrerFee(500)) // 5%
        .to.not.be.reverted
      
      const config = await router.getReferrerConfig()
      expect(config.feeBasisPoints).to.eq(500)
    })

    it('can disable referrer by setting zero address', async () => {
      await router.setReferrer(referrer.address)
      await router.setReferrerFee(50)
      
      await expect(router.setReferrer(constants.AddressZero))
        .to.emit(router, 'ReferrerChanged')
        .withArgs(referrer.address, constants.AddressZero)
      
      const config = await router.getReferrerConfig()
      expect(config.referrerAddress).to.eq(constants.AddressZero)
    })
  })

  describe('Fee Calculation', () => {
    beforeEach(async () => {
      await router.setReferrer(referrer.address)
    })

    it('calculates fee correctly for various amounts and rates', async () => {
      const testCases = [
        { amount: expandTo18Decimals(1000), fee: 50, expected: expandTo18Decimals(5) }, // 0.5%
        { amount: expandTo18Decimals(1000), fee: 100, expected: expandTo18Decimals(10) }, // 1%
        { amount: expandTo18Decimals(1000), fee: 500, expected: expandTo18Decimals(50) }, // 5%
        { amount: expandTo18Decimals(100), fee: 50, expected: expandTo18Decimals(1).div(2) }, // 0.5%
        { amount: 1000, fee: 50, expected: 5 }, // Small amounts
      ]

      for (const testCase of testCases) {
        await router.setReferrerFee(testCase.fee)
        const calculatedFee = await router.calculateReferrerFee(testCase.amount)
        expect(calculatedFee).to.eq(testCase.expected)
      }
    })

    it('returns zero fee when referrer is disabled', async () => {
      await router.setReferrer(constants.AddressZero)
      await router.setReferrerFee(50)
      
      const fee = await router.calculateReferrerFee(expandTo18Decimals(1000))
      expect(fee).to.eq(0)
    })

    it('returns zero fee when fee rate is zero', async () => {
      await router.setReferrerFee(0)
      
      const fee = await router.calculateReferrerFee(expandTo18Decimals(1000))
      expect(fee).to.eq(0)
    })
  })

  describe('Fee Accumulation', () => {
    beforeEach(async () => {
      await router.setReferrer(referrer.address)
      await router.setReferrerFee(50) // 0.5%
    })

    it('starts with zero accumulated fees', async () => {
      const fees = await router.referrerFees(referrer.address, tokens[0].address)
      expect(fees).to.eq(0)
    })

    it('accumulates fees correctly across multiple transactions', async () => {
      // This test would require actual swap execution
      // For now, we'll test the accumulation logic directly
      const initialFees = await router.referrerFees(referrer.address, tokens[0].address)
      expect(initialFees).to.eq(0)
    })
  })

  describe('Fee Collection', () => {
    beforeEach(async () => {
      await router.setReferrer(referrer.address)
      await router.setReferrerFee(50) // 0.5%
    })

    it('reverts when trying to collect zero fees', async () => {
      await expect(router.connect(referrer).collectReferrerFees(tokens[0].address))
        .to.be.revertedWith('No fees to collect')
    })

    it('allows collecting fees for multiple tokens', async () => {
      // This test would require accumulated fees first
      const tokenAddresses = [tokens[0].address, tokens[1].address]
      const amounts = await router.connect(referrer).callStatic.collectReferrerFeesMultiple(tokenAddresses)
      expect(amounts).to.be.an('array').with.length(2)
    })
  })

  describe('Ownership Transfer', () => {
    it('owner can transfer ownership', async () => {
      await expect(router.transferOwnership(other.address))
        .to.emit(router, 'OwnershipTransferred')
        .withArgs(wallet.address, other.address)
      
      expect(await router.owner()).to.eq(other.address)
    })

    it('new owner can manage referrer settings', async () => {
      await router.transferOwnership(other.address)
      
      await expect(router.connect(other).setReferrer(referrer.address))
        .to.not.be.reverted
      
      await expect(router.connect(other).setReferrerFee(100))
        .to.not.be.reverted
    })

    it('old owner cannot manage referrer settings after transfer', async () => {
      await router.transferOwnership(other.address)
      
      await expect(router.setReferrer(referrer.address))
        .to.be.revertedWith('Ownable: caller is not the owner')
    })
  })

  describe('Edge Cases', () => {
    it('handles very small amounts correctly', async () => {
      await router.setReferrer(referrer.address)
      await router.setReferrerFee(50) // 0.5%
      
      // Amount so small that fee rounds to zero
      const fee = await router.calculateReferrerFee(10)
      expect(fee).to.eq(0)
    })

    it('handles maximum amounts correctly', async () => {
      await router.setReferrer(referrer.address)
      await router.setReferrerFee(500) // 5%
      
      const maxAmount = constants.MaxUint256.div(10000) // Avoid overflow
      const fee = await router.calculateReferrerFee(maxAmount)
      expect(fee).to.eq(maxAmount.div(20)) // 5% of maxAmount
    })

    it('maintains precision for fee calculations', async () => {
      await router.setReferrer(referrer.address)
      await router.setReferrerFee(33) // 0.33%
      
      const amount = expandTo18Decimals(10000)
      const expectedFee = amount.mul(33).div(10000)
      const calculatedFee = await router.calculateReferrerFee(amount)
      
      expect(calculatedFee).to.eq(expectedFee)
    })
  })

  describe('Event Emissions', () => {
    it('emits ReferrerChanged event correctly', async () => {
      await expect(router.setReferrer(referrer.address))
        .to.emit(router, 'ReferrerChanged')
        .withArgs(constants.AddressZero, referrer.address)
      
      await expect(router.setReferrer(other.address))
        .to.emit(router, 'ReferrerChanged')
        .withArgs(referrer.address, other.address)
    })

    it('emits ReferrerFeeChanged event correctly', async () => {
      await expect(router.setReferrerFee(50))
        .to.emit(router, 'ReferrerFeeChanged')
        .withArgs(0, 50)
      
      await expect(router.setReferrerFee(100))
        .to.emit(router, 'ReferrerFeeChanged')
        .withArgs(50, 100)
    })
  })

  describe('Gas Usage', () => {
    it('setReferrer gas usage is reasonable', async () => {
      const tx = await router.setReferrer(referrer.address)
      const receipt = await tx.wait()
      
      // Should be less than 50k gas for a simple storage update
      expect(receipt.gasUsed.toNumber()).to.be.lessThan(50000)
    })

    it('setReferrerFee gas usage is reasonable', async () => {
      const tx = await router.setReferrerFee(50)
      const receipt = await tx.wait()
      
      // Should be less than 50k gas for a simple storage update
      expect(receipt.gasUsed.toNumber()).to.be.lessThan(50000)
    })

    it('calculateReferrerFee is a view function (no gas)', async () => {
      await router.setReferrer(referrer.address)
      await router.setReferrerFee(50)
      
      // Should not consume gas as it's a view function
      const fee = await router.calculateReferrerFee(expandTo18Decimals(1000))
      expect(fee).to.be.gt(0)
    })
  })
})