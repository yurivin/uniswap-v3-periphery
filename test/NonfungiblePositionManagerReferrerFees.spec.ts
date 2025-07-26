import { abi as FACTORY_ABI } from '@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json'
import { abi as NFT_DESCRIPTOR_ABI } from '../artifacts/contracts/NonfungibleTokenPositionDescriptor.sol/NonfungibleTokenPositionDescriptor.json'
import { Fixture } from 'ethereum-waffle'
import { constants, Wallet } from 'ethers'
import { waffle, ethers } from 'hardhat'
import { TestERC20, UniswapV3Factory, NonfungiblePositionManager, NonfungibleTokenPositionDescriptor, MockPoolWithPositionManagerFees } from '../typechain'
import completeFixture from './shared/completeFixture'
import { expect } from './shared/expect'
import { encodePriceSqrt } from './shared/encodePriceSqrt'
import { getMaxTick, getMinTick } from './shared/ticks'
import { FeeAmount, TICK_SPACINGS } from './shared/constants'

describe('NonfungiblePositionManager Referrer Fees', () => {
  let wallets: Wallet[]
  let wallet: Wallet, other: Wallet, referrer: Wallet

  const nftFixture: Fixture<{
    factory: UniswapV3Factory
    nft: NonfungiblePositionManager
    nftDescriptor: NonfungibleTokenPositionDescriptor
    tokens: [TestERC20, TestERC20, TestERC20]
    mockPool: MockPoolWithPositionManagerFees
  }> = async (wallets, provider) => {
    const { factory, tokens, nftDescriptor, nft } = await completeFixture(wallets, provider)

    // Deploy mock pool for testing
    const mockPoolFactory = await ethers.getContractFactory('MockPoolWithPositionManagerFees')
    const mockPool = (await mockPoolFactory.deploy(
      tokens[0].address, // token0
      tokens[1].address, // token1
      FeeAmount.MEDIUM // 3000
    )) as MockPoolWithPositionManagerFees

    return {
      factory,
      nft,
      nftDescriptor,
      tokens,
      mockPool,
    }
  }

  let factory: UniswapV3Factory
  let nft: NonfungiblePositionManager
  let nftDescriptor: NonfungibleTokenPositionDescriptor
  let tokens: [TestERC20, TestERC20, TestERC20]
  let mockPool: MockPoolWithPositionManagerFees

  let loadFixture: ReturnType<typeof waffle.createFixtureLoader>

  before('create fixture loader', async () => {
    wallets = await (ethers as any).getSigners()
    ;[wallet, other, referrer] = wallets
    loadFixture = waffle.createFixtureLoader(wallets)
  })

  beforeEach('load fixture', async () => {
    ;({ factory, nft, nftDescriptor, tokens, mockPool } = await loadFixture(nftFixture))
  })

  describe('Fee Collection Configuration', () => {
    describe('#setReferrer', () => {
      it('sets referrer address correctly', async () => {
        await nft.setReferrer(referrer.address)
        const [referrerAddress] = await nft.getReferrerConfig()
        expect(referrerAddress).to.eq(referrer.address)
      })

      it('emits ReferrerChanged event', async () => {
        await expect(nft.setReferrer(referrer.address))
          .to.emit(nft, 'ReferrerChanged')
          .withArgs(constants.AddressZero, referrer.address)
      })

      it('only owner can set referrer', async () => {
        await expect(nft.connect(other).setReferrer(referrer.address)).to.be.revertedWith('Ownable: caller is not the owner')
      })

      it('allows setting referrer to zero address', async () => {
        await nft.setReferrer(referrer.address)
        await nft.setReferrer(constants.AddressZero)
        const [referrerAddress] = await nft.getReferrerConfig()
        expect(referrerAddress).to.eq(constants.AddressZero)
      })
    })

    describe('#setReferrerFeeRate', () => {
      it('sets fee rate correctly', async () => {
        await nft.setReferrerFeeRate(250) // 2.5%
        const [, feeRate] = await nft.getReferrerConfig()
        expect(feeRate).to.eq(250)
      })

      it('emits ReferrerFeeRateChanged event', async () => {
        await expect(nft.setReferrerFeeRate(250))
          .to.emit(nft, 'ReferrerFeeRateChanged')
          .withArgs(0, 250)
      })

      it('only owner can set fee rate', async () => {
        await expect(nft.connect(other).setReferrerFeeRate(250)).to.be.revertedWith('Ownable: caller is not the owner')
      })

      it('rejects fee rate above maximum', async () => {
        await expect(nft.setReferrerFeeRate(501)).to.be.revertedWith('Fee rate too high')
      })

      it('allows fee rate at maximum', async () => {
        await nft.setReferrerFeeRate(500) // 5%
        const [, feeRate] = await nft.getReferrerConfig()
        expect(feeRate).to.eq(500)
      })

      it('allows zero fee rate', async () => {
        await nft.setReferrerFeeRate(100)
        await nft.setReferrerFeeRate(0)
        const [, feeRate] = await nft.getReferrerConfig()
        expect(feeRate).to.eq(0)
      })
    })

    describe('#getReferrerConfig', () => {
      it('returns initial configuration', async () => {
        const [referrerAddress, feeRate] = await nft.getReferrerConfig()
        expect(referrerAddress).to.eq(constants.AddressZero)
        expect(feeRate).to.eq(0)
      })

      it('returns updated configuration', async () => {
        await nft.setReferrer(referrer.address)
        await nft.setReferrerFeeRate(300)
        const [referrerAddress, feeRate] = await nft.getReferrerConfig()
        expect(referrerAddress).to.eq(referrer.address)
        expect(feeRate).to.eq(300)
      })
    })

    describe('#calculateReferrerFee', () => {
      it('returns zero when no referrer configured', async () => {
        const fee = await nft.calculateReferrerFee(1000)
        expect(fee).to.eq(0)
      })

      it('returns zero when referrer configured but fee rate is zero', async () => {
        await nft.setReferrer(referrer.address)
        await nft.setReferrerFeeRate(0)
        const fee = await nft.calculateReferrerFee(1000)
        expect(fee).to.eq(0)
      })

      it('calculates fee correctly', async () => {
        await nft.setReferrer(referrer.address)
        await nft.setReferrerFeeRate(250) // 2.5%
        const fee = await nft.calculateReferrerFee(10000)
        expect(fee).to.eq(250) // 2.5% of 10000
      })

      it('handles various amounts correctly', async () => {
        await nft.setReferrer(referrer.address)
        await nft.setReferrerFeeRate(100) // 1%
        
        expect(await nft.calculateReferrerFee(100)).to.eq(1)
        expect(await nft.calculateReferrerFee(1000)).to.eq(10)
        expect(await nft.calculateReferrerFee(50000)).to.eq(500)
      })

      it('handles rounding correctly', async () => {
        await nft.setReferrer(referrer.address)
        await nft.setReferrerFeeRate(33) // 0.33%
        
        // Should round down due to integer division
        expect(await nft.calculateReferrerFee(100)).to.eq(0) // 100 * 33 / 10000 = 0.33 -> 0
        expect(await nft.calculateReferrerFee(1000)).to.eq(3) // 1000 * 33 / 10000 = 3.3 -> 3
      })
    })
  })

  describe('Fee Collection Functions', () => {
    beforeEach('configure referrer', async () => {
      await nft.setReferrer(referrer.address)
      await nft.setReferrerFeeRate(250) // 2.5%
    })

    describe('#collectFeesFromPool', () => {
      it('reverts when no referrer configured', async () => {
        await nft.setReferrer(constants.AddressZero)
        await expect(nft.collectFeesFromPool(mockPool.address))
          .to.be.revertedWith('No referrer configured')
      })

      it('only owner can collect fees', async () => {
        await expect(nft.connect(other).collectFeesFromPool(mockPool.address))
          .to.be.revertedWith('Ownable: caller is not the owner')
      })

      it('collects fees successfully when fees are available', async () => {
        // Set up mock pool with accumulated fees
        await mockPool.setAccumulatedFees(nft.address, 1000, 2000)
        
        const tx = nft.collectFeesFromPool(mockPool.address)
        await expect(tx)
          .to.emit(mockPool, 'FeesCollected')
          .withArgs(nft.address, referrer.address, 1000, 2000)
        
        const result = await tx
        const receipt = await result.wait()
        // Check that fees were cleared in mock pool
        const [amount0, amount1] = await mockPool.getPositionManagerFees(nft.address)
        expect(amount0).to.eq(0)
        expect(amount1).to.eq(0)
      })

      it('returns correct amounts', async () => {
        await mockPool.setAccumulatedFees(nft.address, 5000, 7500)
        
        const result = await nft.callStatic.collectFeesFromPool(mockPool.address)
        expect(result.amount0).to.eq(5000)
        expect(result.amount1).to.eq(7500)
      })

      it('handles zero fees correctly', async () => {
        // Mock pool starts with zero fees
        const result = await nft.callStatic.collectFeesFromPool(mockPool.address)
        expect(result.amount0).to.eq(0)
        expect(result.amount1).to.eq(0)
      })

      it('validates referrer configuration in mock pool', async () => {
        // Set fees but remove referrer to test mock pool validation
        await mockPool.setAccumulatedFees(nft.address, 1000, 2000)
        await nft.setReferrer(constants.AddressZero)
        
        // The validation happens in position manager first
        await expect(nft.collectFeesFromPool(mockPool.address))
          .to.be.revertedWith('No referrer configured')
      })
    })

    describe('#collectFeesFromPools', () => {
      let mockPool2: MockPoolWithPositionManagerFees

      beforeEach('deploy second mock pool', async () => {
        const mockPoolFactory = await ethers.getContractFactory('MockPoolWithPositionManagerFees')
        mockPool2 = (await mockPoolFactory.deploy(
          tokens[1].address, // token0
          tokens[2].address, // token1  
          FeeAmount.HIGH // 10000
        )) as MockPoolWithPositionManagerFees
      })

      it('reverts when no referrer configured', async () => {
        await nft.setReferrer(constants.AddressZero)
        await expect(nft.collectFeesFromPools([mockPool.address]))
          .to.be.revertedWith('No referrer configured')
      })

      it('only owner can collect fees', async () => {
        await expect(nft.connect(other).collectFeesFromPools([mockPool.address]))
          .to.be.revertedWith('Ownable: caller is not the owner')
      })

      it('collects from single pool correctly', async () => {
        await mockPool.setAccumulatedFees(nft.address, 1000, 2000)
        
        const result = await nft.callStatic.collectFeesFromPools([mockPool.address])
        expect(result.amounts0.length).to.eq(1)
        expect(result.amounts0[0]).to.eq(1000)
        expect(result.amounts1.length).to.eq(1)
        expect(result.amounts1[0]).to.eq(2000)
      })

      it('collects from multiple pools correctly', async () => {
        await mockPool.setAccumulatedFees(nft.address, 1000, 2000)
        await mockPool2.setAccumulatedFees(nft.address, 3000, 4000)
        
        const result = await nft.callStatic.collectFeesFromPools([mockPool.address, mockPool2.address])
        expect(result.amounts0.length).to.eq(2)
        expect(result.amounts0[0]).to.eq(1000)
        expect(result.amounts0[1]).to.eq(3000)
        expect(result.amounts1.length).to.eq(2)
        expect(result.amounts1[0]).to.eq(2000)
        expect(result.amounts1[1]).to.eq(4000)
      })

      it('handles empty pool list', async () => {
        const result = await nft.callStatic.collectFeesFromPools([])
        expect(result.amounts0).to.deep.eq([])
        expect(result.amounts1).to.deep.eq([])
      })

      it('handles pools with zero fees', async () => {
        // Mock pools start with zero fees
        const result = await nft.callStatic.collectFeesFromPools([mockPool.address, mockPool2.address])
        expect(result.amounts0.length).to.eq(2)
        expect(result.amounts0[0]).to.eq(0)
        expect(result.amounts0[1]).to.eq(0)
        expect(result.amounts1.length).to.eq(2)
        expect(result.amounts1[0]).to.eq(0)
        expect(result.amounts1[1]).to.eq(0)
      })

      it('emits events for each pool', async () => {
        await mockPool.setAccumulatedFees(nft.address, 1000, 2000)
        await mockPool2.setAccumulatedFees(nft.address, 3000, 4000)
        
        const tx = nft.collectFeesFromPools([mockPool.address, mockPool2.address])
        
        await expect(tx)
          .to.emit(mockPool, 'FeesCollected')
          .withArgs(nft.address, referrer.address, 1000, 2000)
        
        await expect(tx)
          .to.emit(mockPool2, 'FeesCollected')
          .withArgs(nft.address, referrer.address, 3000, 4000)
      })

      it('handles mixed fee scenarios', async () => {
        await mockPool.setAccumulatedFees(nft.address, 0, 2000) // Only token1 fees
        await mockPool2.setAccumulatedFees(nft.address, 3000, 0) // Only token0 fees
        
        const result = await nft.callStatic.collectFeesFromPools([mockPool.address, mockPool2.address])
        expect(result.amounts0.length).to.eq(2)
        expect(result.amounts0[0]).to.eq(0)
        expect(result.amounts0[1]).to.eq(3000)
        expect(result.amounts1.length).to.eq(2)
        expect(result.amounts1[0]).to.eq(2000)
        expect(result.amounts1[1]).to.eq(0)
      })

      it('clears fees after collection', async () => {
        await mockPool.setAccumulatedFees(nft.address, 1000, 2000)
        await mockPool2.setAccumulatedFees(nft.address, 3000, 4000)
        
        await nft.collectFeesFromPools([mockPool.address, mockPool2.address])
        
        // Verify fees were cleared
        const [amount0_1, amount1_1] = await mockPool.getPositionManagerFees(nft.address)
        const [amount0_2, amount1_2] = await mockPool2.getPositionManagerFees(nft.address)
        
        expect(amount0_1).to.eq(0)
        expect(amount1_1).to.eq(0)
        expect(amount0_2).to.eq(0)
        expect(amount1_2).to.eq(0)
      })
    })
  })

  describe('Integration with Mock Pool', () => {
    beforeEach('configure referrer', async () => {
      await nft.setReferrer(referrer.address)
      await nft.setReferrerFeeRate(250) // 2.5%
    })

    it('mock pool validates referrer configuration', async () => {
      // Set fees in mock pool
      await mockPool.setAccumulatedFees(nft.address, 1000, 2000)
      
      // Remove referrer and try to collect through position manager
      await nft.setReferrer(constants.AddressZero)
      
      // Position manager call should fail because it checks referrer config
      await expect(nft.collectFeesFromPool(mockPool.address))
        .to.be.revertedWith('No referrer configured')
    })

    it('mock pool returns correct fees for view function', async () => {
      await mockPool.setAccumulatedFees(nft.address, 5000, 7500)
      
      const [amount0, amount1] = await mockPool.getPositionManagerFees(nft.address)
      expect(amount0).to.eq(5000)
      expect(amount1).to.eq(7500)
    })

    it('mock pool emits correct events', async () => {
      await mockPool.setAccumulatedFees(nft.address, 1000, 2000)
      
      await expect(mockPool.setAccumulatedFees(nft.address, 3000, 4000))
        .to.emit(mockPool, 'FeesSet')
        .withArgs(nft.address, 3000, 4000)
    })

    it('different position managers have independent fee tracking', async () => {
      // Deploy second position manager
      const nftFactory = await ethers.getContractFactory('NonfungiblePositionManager')
      const nft2 = (await nftFactory.deploy(
        factory.address,
        tokens[0].address, // WETH9
        nftDescriptor.address
      )) as NonfungiblePositionManager
      
      // Set different fees for each position manager
      await mockPool.setAccumulatedFees(nft.address, 1000, 2000)
      await mockPool.setAccumulatedFees(nft2.address, 3000, 4000)
      
      // Verify independent tracking
      const [amount0_1, amount1_1] = await mockPool.getPositionManagerFees(nft.address)
      const [amount0_2, amount1_2] = await mockPool.getPositionManagerFees(nft2.address)
      
      expect(amount0_1).to.eq(1000)
      expect(amount1_1).to.eq(2000)
      expect(amount0_2).to.eq(3000)
      expect(amount1_2).to.eq(4000)
    })
  })

  describe('Edge Cases and Error Handling', () => {
    it('handles large fee amounts', async () => {
      await nft.setReferrer(referrer.address)
      await nft.setReferrerFeeRate(500) // 5%
      
      const largeAmount = ethers.BigNumber.from('340282366920938463463374607431768211455') // uint128 max
      await mockPool.setAccumulatedFees(nft.address, largeAmount, largeAmount)
      
      const result = await nft.callStatic.collectFeesFromPool(mockPool.address)
      expect(result.amount0).to.eq(largeAmount)
      expect(result.amount1).to.eq(largeAmount)
    })

    it('handles referrer configuration changes between setup and collection', async () => {
      await nft.setReferrer(referrer.address)
      await nft.setReferrerFeeRate(250)
      
      // Set fees
      await mockPool.setAccumulatedFees(nft.address, 1000, 2000)
      
      // Change referrer
      await nft.setReferrer(other.address)
      
      // Collection should still work with new referrer
      await expect(nft.collectFeesFromPool(mockPool.address))
        .to.emit(mockPool, 'FeesCollected')
        .withArgs(nft.address, other.address, 1000, 2000)
    })

    it('handles fee rate changes between setup and collection', async () => {
      await nft.setReferrer(referrer.address)
      await nft.setReferrerFeeRate(250)
      
      // Set fees
      await mockPool.setAccumulatedFees(nft.address, 1000, 2000)
      
      // Change fee rate
      await nft.setReferrerFeeRate(500)
      
      // Collection should still work (fees already accumulated)
      const result = await nft.callStatic.collectFeesFromPool(mockPool.address)
      expect(result.amount0).to.eq(1000)
      expect(result.amount1).to.eq(2000)
    })
  })
})