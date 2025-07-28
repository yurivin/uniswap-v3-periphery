import { abi as IUniswapV3PoolABI } from '@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Pool.sol/IUniswapV3Pool.json'
import { Fixture } from 'ethereum-waffle'
import { BigNumber, constants, Wallet } from 'ethers'
import { ethers, waffle } from 'hardhat'
import {
  IUniswapV3Factory,
  IWETH9,
  MockTimeNonfungiblePositionManager,
  SwapRouter,
  TestERC20,
  ISwapRouter,
} from '../typechain'
import completeFixture from './shared/completeFixture'
import { FeeAmount, MaxUint128 } from './shared/constants'
import { encodePriceSqrt } from './shared/encodePriceSqrt'
import { expandTo18Decimals } from './shared/expandTo18Decimals'
import { expect } from './shared/expect'
import { encodePath } from './shared/path'
import poolAtAddress from './shared/poolAtAddress'
import snapshotGasCost from './shared/snapshotGasCost'
import { getMaxTick, getMinTick } from './shared/ticks'

describe('PositionManager Referrer System - Current Implementation', () => {
  let wallets: Wallet[]
  let wallet: Wallet
  let owner: Wallet
  let referrer1: Wallet
  let referrer2: Wallet
  let trader: Wallet
  let other: Wallet

  const positionManagerReferrerFixture: Fixture<{
    nft: MockTimeNonfungiblePositionManager
    factory: IUniswapV3Factory
    tokens: [TestERC20, TestERC20, TestERC20]
    weth9: IWETH9
    router: SwapRouter
  }> = async (wallets, provider) => {
    const { weth9, factory, tokens, nft, router } = await completeFixture(wallets, provider)

    // approve & fund wallets
    for (const token of tokens) {
      await token.approve(nft.address, constants.MaxUint256)
      await token.connect(owner).approve(nft.address, constants.MaxUint256)
      await token.connect(trader).approve(nft.address, constants.MaxUint256)
      await token.connect(trader).approve(router.address, constants.MaxUint256)
      
      // Fund all wallets
      await token.transfer(owner.address, expandTo18Decimals(1_000_000))
      await token.transfer(trader.address, expandTo18Decimals(1_000_000))
    }

    // Transfer contract ownership to owner wallet
    await nft.transferOwnership(owner.address)

    return {
      nft,
      factory,
      tokens,
      weth9,
      router,
    }
  }

  let nft: MockTimeNonfungiblePositionManager
  let factory: IUniswapV3Factory
  let tokens: [TestERC20, TestERC20, TestERC20]
  let weth9: IWETH9
  let router: SwapRouter

  let token0: TestERC20
  let token1: TestERC20
  let token2: TestERC20

  let loadFixture: ReturnType<typeof waffle.createFixtureLoader>

  before('create fixture loader', async () => {
    wallets = await (ethers as any).getSigners()
    ;[wallet, owner, referrer1, referrer2, trader, other] = wallets

    loadFixture = waffle.createFixtureLoader(wallets)
  })

  beforeEach('load fixture and set up tokens', async () => {
    ;({ nft, factory, tokens, weth9, router } = await loadFixture(positionManagerReferrerFixture))
    token0 = tokens[0]
    token1 = tokens[1]
    token2 = tokens[2]
  })

  describe('Referrer Configuration Functions', () => {
    describe('setReferrer()', () => {
      it('allows owner to set referrer address', async () => {
        await expect(nft.connect(owner).setReferrer(referrer1.address))
          .to.emit(nft, 'ReferrerChanged')
          .withArgs(constants.AddressZero, referrer1.address)
        
        const [referrerAddress] = await nft.getReferrerConfig()
        expect(referrerAddress).to.eq(referrer1.address)
      })

      it('allows owner to change referrer address', async () => {
        await nft.connect(owner).setReferrer(referrer1.address)
        
        await expect(nft.connect(owner).setReferrer(referrer2.address))
          .to.emit(nft, 'ReferrerChanged')
          .withArgs(referrer1.address, referrer2.address)
        
        const [referrerAddress] = await nft.getReferrerConfig()
        expect(referrerAddress).to.eq(referrer2.address)
      })

      it('allows setting referrer to zero address', async () => {
        await nft.connect(owner).setReferrer(referrer1.address)
        await nft.connect(owner).setReferrer(constants.AddressZero)
        
        const [referrerAddress] = await nft.getReferrerConfig()
        expect(referrerAddress).to.eq(constants.AddressZero)
      })

      it('reverts when non-owner tries to set referrer', async () => {
        await expect(nft.connect(other).setReferrer(referrer1.address))
          .to.be.revertedWith('Ownable: caller is not the owner')
      })
    })

    describe('setReferrerFeeRate()', () => {
      it('allows owner to set fee rate', async () => {
        const feeRate = 500 // 5%
        await expect(nft.connect(owner).setReferrerFeeRate(feeRate))
          .to.emit(nft, 'ReferrerFeeRateChanged')
          .withArgs(0, feeRate)
        
        const [, currentRate] = await nft.getReferrerConfig()
        expect(currentRate).to.eq(feeRate)
      })

      it('allows setting maximum fee rate (100%)', async () => {
        const maxFeeRate = 10000 // 100%
        await nft.connect(owner).setReferrerFeeRate(maxFeeRate)
        
        const [, currentRate] = await nft.getReferrerConfig()
        expect(currentRate).to.eq(maxFeeRate)
      })

      it('allows setting zero fee rate', async () => {
        await nft.connect(owner).setReferrerFeeRate(500)
        await nft.connect(owner).setReferrerFeeRate(0)
        
        const [, currentRate] = await nft.getReferrerConfig()
        expect(currentRate).to.eq(0)
      })

      it('reverts when fee rate exceeds maximum', async () => {
        await expect(nft.connect(owner).setReferrerFeeRate(10001))
          .to.be.revertedWith('Fee rate too high')
      })

      it('reverts when non-owner tries to set fee rate', async () => {
        await expect(nft.connect(other).setReferrerFeeRate(500))
          .to.be.revertedWith('Ownable: caller is not the owner')
      })
    })
  })

  describe('View Functions', () => {
    beforeEach('configure referrer', async () => {
      await nft.connect(owner).setReferrer(referrer1.address)
      await nft.connect(owner).setReferrerFeeRate(250) // 2.5%
    })

    describe('getReferrerConfig()', () => {
      it('returns correct referrer address and fee rate', async () => {
        const [referrerAddress, feeRate] = await nft.getReferrerConfig()
        expect(referrerAddress).to.eq(referrer1.address)
        expect(feeRate).to.eq(250)
      })

      it('returns zero values when not configured', async () => {
        const nftFactory = await ethers.getContractFactory('MockTimeNonfungiblePositionManager')
        const newNft = await nftFactory.deploy(factory.address, weth9.address, constants.AddressZero)
        
        const [referrerAddress, feeRate] = await newNft.getReferrerConfig()
        expect(referrerAddress).to.eq(constants.AddressZero)
        expect(feeRate).to.eq(0)
      })
    })

    describe('getReferrerFeeRate()', () => {
      it('returns current fee rate for Pool calls', async () => {
        const feeRate = await nft.getReferrerFeeRate()
        expect(feeRate).to.eq(250)
      })

      it('returns zero when fee rate not set', async () => {
        await nft.connect(owner).setReferrerFeeRate(0)
        const feeRate = await nft.getReferrerFeeRate()
        expect(feeRate).to.eq(0)
      })
    })

    // calculateReferrerFee() function removed for contract size optimization
    // Frontend should calculate: (amount * referrerFeeRate) / 10000
  })

  describe('Initial State', () => {
    it('has zero referrer and fee rate initially', async () => {
      const [referrerAddress, feeRate] = await nft.getReferrerConfig()
      expect(referrerAddress).to.eq(constants.AddressZero)
      expect(feeRate).to.eq(0)
    })

    it('has zero referrer fee rate initially', async () => {
      const feeRate = await nft.getReferrerFeeRate()
      expect(feeRate).to.eq(0)
    })
  })

  describe('Edge Cases', () => {
    it('handles maximum fee rate setting', async () => {
      await nft.connect(owner).setReferrer(referrer1.address)
      await nft.connect(owner).setReferrerFeeRate(10000) // 100%
      
      const [referrerAddress, feeRate] = await nft.getReferrerConfig()
      expect(referrerAddress).to.eq(referrer1.address)
      expect(feeRate).to.eq(10000)
    })

    it('allows multiple configuration changes', async () => {
      // First configuration
      await nft.connect(owner).setReferrer(referrer1.address)
      await nft.connect(owner).setReferrerFeeRate(100)
      
      // Second configuration
      await nft.connect(owner).setReferrer(referrer2.address)
      await nft.connect(owner).setReferrerFeeRate(200)
      
      // Third configuration
      await nft.connect(owner).setReferrer(constants.AddressZero)
      await nft.connect(owner).setReferrerFeeRate(0)
      
      const [referrerAddress, feeRate] = await nft.getReferrerConfig()
      expect(referrerAddress).to.eq(constants.AddressZero)
      expect(feeRate).to.eq(0)
    })
  })

  describe('Gas Usage', () => {
    it('setReferrer has reasonable gas cost', async () => {
      await snapshotGasCost(nft.connect(owner).setReferrer(referrer1.address))
    })

    it('setReferrerFeeRate has reasonable gas cost', async () => {
      await snapshotGasCost(nft.connect(owner).setReferrerFeeRate(500))
    })

    it('getReferrerConfig has minimal gas cost', async () => {
      await nft.connect(owner).setReferrer(referrer1.address)
      await nft.connect(owner).setReferrerFeeRate(500)
      
      // View functions don't consume gas in transactions, but we can check the call
      const [referrerAddress, feeRate] = await nft.getReferrerConfig()
      expect(referrerAddress).to.eq(referrer1.address)
      expect(feeRate).to.eq(500)
    })

    it('getReferrerFeeRate has minimal gas cost', async () => {
      await nft.connect(owner).setReferrerFeeRate(500)
      
      const feeRate = await nft.getReferrerFeeRate()
      expect(feeRate).to.eq(500)
    })
  })
})