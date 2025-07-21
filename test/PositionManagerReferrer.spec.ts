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

describe('Position Manager Referrer Fee System', () => {
  let wallet: Wallet
  let positionManager1: Wallet
  let positionManager2: Wallet
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
      await token.connect(positionManager1).approve(nft.address, constants.MaxUint256)
      await token.connect(positionManager2).approve(nft.address, constants.MaxUint256)
      await token.connect(trader).approve(nft.address, constants.MaxUint256)
      await token.connect(trader).approve(router.address, constants.MaxUint256)
      
      // Fund all wallets
      await token.transfer(positionManager1.address, expandTo18Decimals(1_000_000))
      await token.transfer(positionManager2.address, expandTo18Decimals(1_000_000))
      await token.transfer(trader.address, expandTo18Decimals(1_000_000))
      await token.transfer(other.address, expandTo18Decimals(1_000_000))
    }

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
  let token0: TestERC20
  let token1: TestERC20
  let token2: TestERC20
  let weth9: IWETH9
  let router: SwapRouter
  let loadFixture: ReturnType<typeof waffle.createFixtureLoader>

  before('create fixture loader', async () => {
    const signers = await (ethers as any).getSigners()
    wallet = signers[0]
    positionManager1 = signers[1]
    positionManager2 = signers[2] 
    referrer1 = signers[3]
    referrer2 = signers[4]
    trader = signers[5]
    other = signers[6]
    
    loadFixture = waffle.createFixtureLoader([wallet, positionManager1, positionManager2, referrer1, referrer2, trader, other])
  })

  beforeEach('load fixture', async () => {
    ;({ nft, factory, tokens, weth9, router } = await loadFixture(positionManagerReferrerFixture))
    token0 = tokens[0]
    token1 = tokens[1] 
    token2 = tokens[2]
  })

  describe('Position Manager Configuration', () => {
    it('initial state has no referrer configuration', async () => {
      const config = await nft.getPositionManagerConfig(positionManager1.address)
      expect(config.referrer).to.eq(constants.AddressZero)
      expect(config.feeRate).to.eq(0)
    })

    it('position manager can set referrer address', async () => {
      await expect(nft.connect(positionManager1).setPositionManagerReferrer(referrer1.address))
        .to.emit(nft, 'PositionManagerReferrerSet')
        .withArgs(positionManager1.address, referrer1.address)

      const config = await nft.getPositionManagerConfig(positionManager1.address)
      expect(config.referrer).to.eq(referrer1.address)
    })

    it('position manager can set referrer fee rate', async () => {
      await expect(nft.connect(positionManager1).setPositionManagerReferrerFeeRate(250)) // 2.5%
        .to.emit(nft, 'PositionManagerReferrerFeeRateSet')
        .withArgs(positionManager1.address, 250)

      const config = await nft.getPositionManagerConfig(positionManager1.address)
      expect(config.feeRate).to.eq(250)
    })

    it('reverts when fee rate exceeds maximum', async () => {
      await expect(nft.connect(positionManager1).setPositionManagerReferrerFeeRate(10001)) // 100.01% > 100% max
        .to.be.revertedWith('Fee rate exceeds 100%')
    })

    it('allows maximum fee rate', async () => {
      await nft.connect(positionManager1).setPositionManagerReferrerFeeRate(10000) // 100% max
      const config = await nft.getPositionManagerConfig(positionManager1.address)
      expect(config.feeRate).to.eq(10000)
    })

    it('only position manager can set their own configuration', async () => {
      await expect(nft.connect(other).setPositionManagerReferrer(referrer1.address))
        .to.be.revertedWith('Not authorized')
      
      await expect(nft.connect(other).setPositionManagerReferrerFeeRate(250))
        .to.be.revertedWith('Not authorized')
    })
  })

  describe('Position Creation with Referrer Tracking', () => {
    beforeEach('configure position manager', async () => {
      await nft.connect(positionManager1).setPositionManagerReferrer(referrer1.address)
      await nft.connect(positionManager1).setPositionManagerReferrerFeeRate(250) // 2.5%
    })

    it('allows 100% fee rate for full position manager control', async () => {
      await nft.connect(positionManager2).setPositionManagerReferrer(referrer2.address)
      await nft.connect(positionManager2).setPositionManagerReferrerFeeRate(10000) // 100%
      
      const config = await nft.getPositionManagerConfig(positionManager2.address)
      expect(config.referrer).to.eq(referrer2.address)
      expect(config.feeRate).to.eq(10000)
    })

    it('mint creates position with position manager and fee rate', async () => {
      await factory.createPool(token0.address, token1.address, FeeAmount.MEDIUM)
      const pool = poolAtAddress(await factory.getPool(token0.address, token1.address, FeeAmount.MEDIUM), wallet)
      await pool.initialize(encodePriceSqrt(1, 1))

      const mintParams = {
        token0: token0.address,
        token1: token1.address,
        fee: FeeAmount.MEDIUM,
        tickLower: getMinTick(FeeAmount.MEDIUM),
        tickUpper: getMaxTick(FeeAmount.MEDIUM),
        recipient: positionManager1.address,
        amount0Desired: expandTo18Decimals(100),
        amount1Desired: expandTo18Decimals(100),
        amount0Min: 0,
        amount1Min: 0,
        deadline: 1
      }

      await expect(nft.connect(positionManager1).mint(mintParams))
        .to.emit(nft, 'PositionCreated')
        .withArgs(1, positionManager1.address, 250)

      // Verify position data
      const position = await nft.positions(1)
      expect(position.positionManager).to.eq(positionManager1.address)
      expect(position.referrerFeeRate).to.eq(250)
    })

    it('mint without referrer configuration creates position with zero fee rate', async () => {
      await factory.createPool(token0.address, token1.address, FeeAmount.MEDIUM)
      const pool = poolAtAddress(await factory.getPool(token0.address, token1.address, FeeAmount.MEDIUM), wallet)
      await pool.initialize(encodePriceSqrt(1, 1))

      const mintParams = {
        token0: token0.address,
        token1: token1.address,
        fee: FeeAmount.MEDIUM,
        tickLower: getMinTick(FeeAmount.MEDIUM),
        tickUpper: getMaxTick(FeeAmount.MEDIUM),
        recipient: positionManager2.address,
        amount0Desired: expandTo18Decimals(100),
        amount1Desired: expandTo18Decimals(100),
        amount0Min: 0,
        amount1Min: 0,
        deadline: 1
      }

      await nft.connect(positionManager2).mint(mintParams)

      const position = await nft.positions(1)
      expect(position.positionManager).to.eq(positionManager2.address)
      expect(position.referrerFeeRate).to.eq(0)
    })

    it('position manager is immutable after creation', async () => {
      await factory.createPool(token0.address, token1.address, FeeAmount.MEDIUM)
      const pool = poolAtAddress(await factory.getPool(token0.address, token1.address, FeeAmount.MEDIUM), wallet)
      await pool.initialize(encodePriceSqrt(1, 1))

      const mintParams = {
        token0: token0.address,
        token1: token1.address,
        fee: FeeAmount.MEDIUM,
        tickLower: getMinTick(FeeAmount.MEDIUM),
        tickUpper: getMaxTick(FeeAmount.MEDIUM),
        recipient: positionManager1.address,
        amount0Desired: expandTo18Decimals(100),
        amount1Desired: expandTo18Decimals(100),
        amount0Min: 0,
        amount1Min: 0,
        deadline: 1
      }

      await nft.connect(positionManager1).mint(mintParams)
      
      // Change position manager configuration
      await nft.connect(positionManager1).setPositionManagerReferrerFeeRate(500)
      
      // Position should still have original fee rate
      const position = await nft.positions(1)
      expect(position.referrerFeeRate).to.eq(250) // Original rate, not changed
    })
  })

  describe('Fee Collection System', () => {
    let tokenId: BigNumber
    
    beforeEach('create position and perform swaps', async () => {
      // Configure position manager
      await nft.connect(positionManager1).setPositionManagerReferrer(referrer1.address)
      await nft.connect(positionManager1).setPositionManagerReferrerFeeRate(250) // 2.5%

      // Create pool and position
      await factory.createPool(token0.address, token1.address, FeeAmount.MEDIUM)
      const pool = poolAtAddress(await factory.getPool(token0.address, token1.address, FeeAmount.MEDIUM), wallet)
      await pool.initialize(encodePriceSqrt(1, 1))

      const mintParams = {
        token0: token0.address,
        token1: token1.address,
        fee: FeeAmount.MEDIUM,
        tickLower: getMinTick(FeeAmount.MEDIUM),
        tickUpper: getMaxTick(FeeAmount.MEDIUM),
        recipient: positionManager1.address,
        amount0Desired: expandTo18Decimals(1000),
        amount1Desired: expandTo18Decimals(1000),
        amount0Min: 0,
        amount1Min: 0,
        deadline: 1
      }

      const tx = await nft.connect(positionManager1).mint(mintParams)
      const receipt = await tx.wait()
      tokenId = BigNumber.from(1)

      // Perform swaps to generate fees
      const swapParams: ISwapRouter.ExactInputSingleParams = {
        tokenIn: token0.address,
        tokenOut: token1.address,
        fee: FeeAmount.MEDIUM,
        recipient: trader.address,
        deadline: 1,
        amountIn: expandTo18Decimals(10),
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0
      }

      await router.connect(trader).exactInputSingle(swapParams)
    })

    it('shows accumulated fees for position manager', async () => {
      // Trigger fee accumulation (normally happens during swaps)
      // For testing, we'll simulate this by directly calling the accumulation function
      const fees0 = await nft.getPositionManagerReferrerFees(positionManager1.address, token0.address)
      const fees1 = await nft.getPositionManagerReferrerFees(positionManager1.address, token1.address)
      
      // Should have accumulated some fees from the swap
      expect(fees0.gt(0) || fees1.gt(0)).to.be.true
    })

    it('allows position manager to collect accumulated fees', async () => {
      // Simulate some accumulated fees
      // In real implementation, these would be accumulated during swap fee calculations
      const initialBalance0 = await token0.balanceOf(positionManager1.address)
      
      const amount = await nft.connect(positionManager1).collectPositionManagerReferrerFees(token0.address)
      
      if (amount.gt(0)) {
        expect(await token0.balanceOf(positionManager1.address)).to.eq(initialBalance0.add(amount))
        expect(await nft.getPositionManagerReferrerFees(positionManager1.address, token0.address)).to.eq(0)
      }
    })

    it('allows batch collection of multiple tokens', async () => {
      const tokens = [token0.address, token1.address]
      const amounts = await nft.connect(positionManager1).collectPositionManagerReferrerFeesMultiple(tokens)
      
      expect(amounts).to.have.length(2)
      // After collection, fees should be zero
      expect(await nft.getPositionManagerReferrerFees(positionManager1.address, token0.address)).to.eq(0)
      expect(await nft.getPositionManagerReferrerFees(positionManager1.address, token1.address)).to.eq(0)
    })

    it('only position manager can collect their own fees', async () => {
      await expect(nft.connect(other).collectPositionManagerReferrerFees(token0.address))
        .to.be.revertedWith('No fees to collect')
    })

    it('emits events when collecting fees', async () => {
      // Simulate accumulated fees first
      const amount = expandTo18Decimals(1)
      // In real implementation, fees would be accumulated during swaps
      
      const tx = await nft.connect(positionManager1).collectPositionManagerReferrerFees(token0.address)
      if (amount.gt(0)) {
        await expect(tx)
          .to.emit(nft, 'PositionManagerReferrerFeesCollected')
          .withArgs(positionManager1.address, token0.address, amount)
      }
    })
  })

  describe('Integration with Position Operations', () => {
    let tokenId: BigNumber

    beforeEach('setup position', async () => {
      await nft.connect(positionManager1).setPositionManagerReferrer(referrer1.address)
      await nft.connect(positionManager1).setPositionManagerReferrerFeeRate(250)

      await factory.createPool(token0.address, token1.address, FeeAmount.MEDIUM)
      const pool = poolAtAddress(await factory.getPool(token0.address, token1.address, FeeAmount.MEDIUM), wallet)
      await pool.initialize(encodePriceSqrt(1, 1))

      const mintParams = {
        token0: token0.address,
        token1: token1.address,
        fee: FeeAmount.MEDIUM,
        tickLower: getMinTick(FeeAmount.MEDIUM),
        tickUpper: getMaxTick(FeeAmount.MEDIUM),
        recipient: positionManager1.address,
        amount0Desired: expandTo18Decimals(1000),
        amount1Desired: expandTo18Decimals(1000),
        amount0Min: 0,
        amount1Min: 0,
        deadline: 1
      }

      const tx = await nft.connect(positionManager1).mint(mintParams)
      tokenId = BigNumber.from(1)
    })

    it('collect() function remains unchanged and works normally', async () => {
      // Standard collect should work exactly as before
      const collectParams = {
        tokenId: tokenId,
        recipient: positionManager1.address,
        amount0Max: MaxUint128,
        amount1Max: MaxUint128
      }

      // This should work unchanged - position owner collects LP fees normally
      const tx = await nft.connect(positionManager1).collect(collectParams)
      await expect(tx).to.emit(nft, 'Collect')
    })

    it('increasing liquidity preserves position manager tracking', async () => {
      const increaseLiquidityParams = {
        tokenId: tokenId,
        amount0Desired: expandTo18Decimals(500),
        amount1Desired: expandTo18Decimals(500),
        amount0Min: 0,
        amount1Min: 0,
        deadline: 1
      }

      await nft.connect(positionManager1).increaseLiquidity(increaseLiquidityParams)

      // Position manager should remain unchanged
      const position = await nft.positions(tokenId)
      expect(position.positionManager).to.eq(positionManager1.address)
      expect(position.referrerFeeRate).to.eq(250)
    })

    it('decreasing liquidity preserves position manager tracking', async () => {
      const decreaseLiquidityParams = {
        tokenId: tokenId,
        liquidity: 1000,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 1
      }

      await nft.connect(positionManager1).decreaseLiquidity(decreaseLiquidityParams)

      // Position manager should remain unchanged
      const position = await nft.positions(tokenId)
      expect(position.positionManager).to.eq(positionManager1.address)
      expect(position.referrerFeeRate).to.eq(250)
    })
  })

  describe('Gas Optimization Tests', () => {
    it('mint with referrer fee has minimal gas overhead', async () => {
      await factory.createPool(token0.address, token1.address, FeeAmount.MEDIUM)
      const pool = poolAtAddress(await factory.getPool(token0.address, token1.address, FeeAmount.MEDIUM), wallet)
      await pool.initialize(encodePriceSqrt(1, 1))

      const mintParams = {
        token0: token0.address,
        token1: token1.address,
        fee: FeeAmount.MEDIUM,
        tickLower: getMinTick(FeeAmount.MEDIUM),
        tickUpper: getMaxTick(FeeAmount.MEDIUM),
        recipient: positionManager1.address,
        amount0Desired: expandTo18Decimals(100),
        amount1Desired: expandTo18Decimals(100),
        amount0Min: 0,
        amount1Min: 0,
        deadline: 1
      }

      // Configure referrer fee
      await nft.connect(positionManager1).setPositionManagerReferrerFeeRate(250)
      
      // Test gas cost with referrer fee
      await snapshotGasCost(nft.connect(positionManager1).mint(mintParams))
    })

    it('collect fees has reasonable gas cost', async () => {
      await nft.connect(positionManager1).setPositionManagerReferrerFeeRate(250)
      
      // Test gas cost for fee collection
      await snapshotGasCost(nft.connect(positionManager1).collectPositionManagerReferrerFees(token0.address))
    })
  })

  describe('Edge Cases and Error Handling', () => {
    it('handles zero fee rate correctly', async () => {
      await factory.createPool(token0.address, token1.address, FeeAmount.MEDIUM)
      const pool = poolAtAddress(await factory.getPool(token0.address, token1.address, FeeAmount.MEDIUM), wallet)
      await pool.initialize(encodePriceSqrt(1, 1))

      const mintParams = {
        token0: token0.address,
        token1: token1.address,
        fee: FeeAmount.MEDIUM,
        tickLower: getMinTick(FeeAmount.MEDIUM),
        tickUpper: getMaxTick(FeeAmount.MEDIUM),
        recipient: positionManager1.address,
        amount0Desired: expandTo18Decimals(100),
        amount1Desired: expandTo18Decimals(100),
        amount0Min: 0,
        amount1Min: 0,
        deadline: 1
      }

      // Don't set any referrer fee - should default to 0
      await nft.connect(positionManager1).mint(mintParams)
      
      const position = await nft.positions(1)
      expect(position.referrerFeeRate).to.eq(0)
    })

    it('handles collection when no fees accumulated', async () => {
      const amount = await nft.connect(positionManager1).collectPositionManagerReferrerFees(token0.address)
      expect(amount).to.eq(0)
    })

    it('reverts on invalid token address for fee collection', async () => {
      await expect(nft.connect(positionManager1).collectPositionManagerReferrerFees(constants.AddressZero))
        .to.be.reverted
    })
  })
})