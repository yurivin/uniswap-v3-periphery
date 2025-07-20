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

describe('SwapRouter Backwards Compatibility Tests', function () {
  this.timeout(40000)
  let wallet: Wallet
  let trader: Wallet

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
    ;[wallet, trader] = await (ethers as any).getSigners()
    loadFixture = waffle.createFixtureLoader([wallet, trader])
  })

  beforeEach('load fixture', async () => {
    ;({ weth9, router, tokens, nft } = await loadFixture(swapRouterFixture))
    
    // Ensure referrer is disabled for backwards compatibility tests
    await router.setReferrer(constants.AddressZero)
    await router.setReferrerFee(0)
    
    // Create pools and add liquidity (same as original tests)
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

  describe('Exact Backwards Compatibility', () => {
    it('exactInputSingle behaves identically to original when referrer disabled', async () => {
      const inputAmount = expandTo18Decimals(1)

      const token0BalanceBefore = await tokens[0].balanceOf(trader.address)
      const token1BalanceBefore = await tokens[1].balanceOf(trader.address)

      const result = await router.connect(trader).exactInputSingle({
        tokenIn: tokens[0].address,
        tokenOut: tokens[1].address,
        fee: FeeAmount.MEDIUM,
        recipient: trader.address,
        deadline: 1,
        amountIn: inputAmount,
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0,
      })

      const token0BalanceAfter = await tokens[0].balanceOf(trader.address)
      const token1BalanceAfter = await tokens[1].balanceOf(trader.address)

      // Should consume exactly the input amount (no referrer fee)
      expect(token0BalanceBefore.sub(token0BalanceAfter)).to.eq(inputAmount)
      
      // Should receive some output
      expect(token1BalanceAfter.sub(token1BalanceBefore)).to.be.gt(0)
      
      // No referrer fees should be accumulated
      expect(await router.referrerFees(constants.AddressZero, tokens[0].address)).to.eq(0)
      
      // Router should have no leftover balance
      expect(await tokens[0].balanceOf(router.address)).to.eq(0)
      expect(await tokens[1].balanceOf(router.address)).to.eq(0)
    })

    it('exactInput multi-hop behaves identically to original', async () => {
      const inputAmount = expandTo18Decimals(3)
      const path = encodePath([tokens[0].address, tokens[1].address, tokens[2].address], [FeeAmount.MEDIUM, FeeAmount.MEDIUM])

      const token0BalanceBefore = await tokens[0].balanceOf(trader.address)
      const token2BalanceBefore = await tokens[2].balanceOf(trader.address)

      await router.connect(trader).exactInput({
        path: path,
        recipient: trader.address,
        deadline: 1,
        amountIn: inputAmount,
        amountOutMinimum: 0,
      })

      const token0BalanceAfter = await tokens[0].balanceOf(trader.address)
      const token2BalanceAfter = await tokens[2].balanceOf(trader.address)

      // Should consume exactly the input amount
      expect(token0BalanceBefore.sub(token0BalanceAfter)).to.eq(inputAmount)
      
      // Should receive output in final token
      expect(token2BalanceAfter.sub(token2BalanceBefore)).to.be.gt(0)
      
      // No tokens should remain in router
      expect(await tokens[0].balanceOf(router.address)).to.eq(0)
      expect(await tokens[1].balanceOf(router.address)).to.eq(0)
      expect(await tokens[2].balanceOf(router.address)).to.eq(0)
    })

    it('exactOutputSingle behaves identically to original', async () => {
      const outputAmount = expandTo18Decimals(1)

      const token0BalanceBefore = await tokens[0].balanceOf(trader.address)
      const token1BalanceBefore = await tokens[1].balanceOf(trader.address)

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

      const token0BalanceAfter = await tokens[0].balanceOf(trader.address)
      const token1BalanceAfter = await tokens[1].balanceOf(trader.address)

      // Should consume exactly the calculated input amount
      expect(token0BalanceBefore.sub(token0BalanceAfter)).to.eq(amountIn)
      
      // Should receive exactly the requested output
      expect(token1BalanceAfter.sub(token1BalanceBefore)).to.eq(outputAmount)
      
      // No tokens should remain in router
      expect(await tokens[0].balanceOf(router.address)).to.eq(0)
      expect(await tokens[1].balanceOf(router.address)).to.eq(0)
    })

    it('exactOutput multi-hop behaves identically to original', async () => {
      const outputAmount = expandTo18Decimals(1)
      const path = encodePath([tokens[2].address, tokens[1].address, tokens[0].address], [FeeAmount.MEDIUM, FeeAmount.MEDIUM])

      const token0BalanceBefore = await tokens[0].balanceOf(trader.address)
      const token2BalanceBefore = await tokens[2].balanceOf(trader.address)

      const amountIn = await router.connect(trader).callStatic.exactOutput({
        path: path,
        recipient: trader.address,
        deadline: 1,
        amountOut: outputAmount,
        amountInMaximum: constants.MaxUint256,
      })

      await router.connect(trader).exactOutput({
        path: path,
        recipient: trader.address,
        deadline: 1,
        amountOut: outputAmount,
        amountInMaximum: constants.MaxUint256,
      })

      const token0BalanceAfter = await tokens[0].balanceOf(trader.address)
      const token2BalanceAfter = await tokens[2].balanceOf(trader.address)

      // Should receive exactly the requested output
      expect(token0BalanceAfter.sub(token0BalanceBefore)).to.eq(outputAmount)
      
      // Should consume the calculated input amount
      expect(token2BalanceBefore.sub(token2BalanceAfter)).to.eq(amountIn)
      
      // No tokens should remain in router
      expect(await tokens[0].balanceOf(router.address)).to.eq(0)
      expect(await tokens[1].balanceOf(router.address)).to.eq(0)
      expect(await tokens[2].balanceOf(router.address)).to.eq(0)
    })
  })

  describe('Interface Compatibility', () => {
    it('all original functions are still available', async () => {
      // Core swap functions
      expect(typeof router.exactInputSingle).to.eq('function')
      expect(typeof router.exactInput).to.eq('function')
      expect(typeof router.exactOutputSingle).to.eq('function')
      expect(typeof router.exactOutput).to.eq('function')
      
      // Callback function
      expect(typeof router.uniswapV3SwapCallback).to.eq('function')
      
      // Inherited functions should still work
      expect(typeof router.multicall).to.eq('function')
      expect(typeof router.selfPermit).to.eq('function')
      expect(typeof router.selfPermitIfNecessary).to.eq('function')
      expect(typeof router.selfPermitAllowed).to.eq('function')
      expect(typeof router.selfPermitAllowedIfNecessary).to.eq('function')
    })

    it('function signatures remain unchanged', async () => {
      const inputSingleInterface = router.interface.getFunction('exactInputSingle')
      const inputInterface = router.interface.getFunction('exactInput')
      const outputSingleInterface = router.interface.getFunction('exactOutputSingle')
      const outputInterface = router.interface.getFunction('exactOutput')

      // Verify function names
      expect(inputSingleInterface.name).to.eq('exactInputSingle')
      expect(inputInterface.name).to.eq('exactInput')
      expect(outputSingleInterface.name).to.eq('exactOutputSingle')
      expect(outputInterface.name).to.eq('exactOutput')

      // Verify parameter counts (should be unchanged)
      expect(inputSingleInterface.inputs.length).to.eq(1) // ExactInputSingleParams
      expect(inputInterface.inputs.length).to.eq(1) // ExactInputParams
      expect(outputSingleInterface.inputs.length).to.eq(1) // ExactOutputSingleParams
      expect(outputInterface.inputs.length).to.eq(1) // ExactOutputParams
    })
  })

  describe('Gas Usage Baseline', () => {
    it('establishes gas usage baseline for comparison', async () => {
      const inputAmount = expandTo18Decimals(1)

      const tx = await router.connect(trader).exactInputSingle({
        tokenIn: tokens[0].address,
        tokenOut: tokens[1].address,
        fee: FeeAmount.MEDIUM,
        recipient: trader.address,
        deadline: 1,
        amountIn: inputAmount,
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0,
      })

      const receipt = await tx.wait()
      console.log(`Baseline gas usage (no referrer): ${receipt.gasUsed.toString()}`)

      // Should be reasonable gas usage
      expect(receipt.gasUsed.toNumber()).to.be.lessThan(200000)
    })
  })

  describe('State Isolation', () => {
    it('referrer state does not affect swaps when disabled', async () => {
      // Set referrer settings but keep them disabled
      await router.setReferrer(constants.AddressZero)
      await router.setReferrerFee(500) // 5% fee rate set but referrer disabled

      const inputAmount = expandTo18Decimals(1)
      const token0BalanceBefore = await tokens[0].balanceOf(trader.address)

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

      const token0BalanceAfter = await tokens[0].balanceOf(trader.address)

      // Should consume exactly input amount (no fee despite fee rate being set)
      expect(token0BalanceBefore.sub(token0BalanceAfter)).to.eq(inputAmount)
      
      // No fees should be accumulated despite fee rate being set
      expect(await router.referrerFees(constants.AddressZero, tokens[0].address)).to.eq(0)
    })

    it('referrer functions do not interfere with original swap logic', async () => {
      const inputAmount = expandTo18Decimals(1)

      // Get baseline result
      const result1 = await router.connect(trader).callStatic.exactInputSingle({
        tokenIn: tokens[0].address,
        tokenOut: tokens[1].address,
        fee: FeeAmount.MEDIUM,
        recipient: trader.address,
        deadline: 1,
        amountIn: inputAmount,
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0,
      })

      // Call referrer view functions
      await router.getReferrerConfig()
      await router.calculateReferrerFee(inputAmount)

      // Get result after referrer function calls
      const result2 = await router.connect(trader).callStatic.exactInputSingle({
        tokenIn: tokens[0].address,
        tokenOut: tokens[1].address,
        fee: FeeAmount.MEDIUM,
        recipient: trader.address,
        deadline: 1,
        amountIn: inputAmount,
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0,
      })

      // Results should be identical
      expect(result1).to.eq(result2)
    })
  })

  describe('Event Compatibility', () => {
    it('does not emit referrer events when referrer is disabled', async () => {
      const inputAmount = expandTo18Decimals(1)

      const tx = await router.connect(trader).exactInputSingle({
        tokenIn: tokens[0].address,
        tokenOut: tokens[1].address,
        fee: FeeAmount.MEDIUM,
        recipient: trader.address,
        deadline: 1,
        amountIn: inputAmount,
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0,
      })

      const receipt = await tx.wait()

      // Should not emit any referrer-related events
      const referrerEvents = receipt.events?.filter(e => 
        e.event === 'ReferrerFeeAccumulated' || 
        e.event === 'ReferrerChanged' || 
        e.event === 'ReferrerFeeChanged'
      )

      expect(referrerEvents?.length || 0).to.eq(0)
    })
  })
})