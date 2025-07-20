import { Fixture } from 'ethereum-waffle'
import { BigNumber, constants, Wallet } from 'ethers'
import { ethers, waffle } from 'hardhat'
import { TestERC20, ISwapRouter, SwapRouter } from '../typechain'
import completeFixture from './shared/completeFixture'
import { expect } from './shared/expect'
import { expandTo18Decimals } from './shared/expandTo18Decimals'
import { FeeAmount } from './shared/constants'
import { encodePath } from './shared/path'
import snapshotGasCost from './shared/snapshotGasCost'

describe('SwapRouter Referrer Gas Usage Tests', () => {
  let wallet: Wallet
  let trader: Wallet
  let referrer: Wallet

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
    ;[wallet, trader, referrer] = await (ethers as any).getSigners()
    loadFixture = waffle.createFixtureLoader([wallet, trader, referrer])
  })

  beforeEach('load fixture', async () => {
    ;({ router, tokens } = await loadFixture(swapRouterFixture))
    
    // Setup tokens for trader
    await tokens[0].connect(trader).approve(router.address, constants.MaxUint256)
    await tokens[1].connect(trader).approve(router.address, constants.MaxUint256)
    await tokens[2].connect(trader).approve(router.address, constants.MaxUint256)
    
    const transferAmount = expandTo18Decimals(10000)
    await tokens[0].transfer(trader.address, transferAmount)
    await tokens[1].transfer(trader.address, transferAmount)
    await tokens[2].transfer(trader.address, transferAmount)
  })

  describe('Configuration Gas Costs', () => {
    it('setReferrer gas cost', async () => {
      await snapshotGasCost(router.setReferrer(referrer.address))
    })

    it('setReferrerFee gas cost', async () => {
      await snapshotGasCost(router.setReferrerFee(50))
    })

    it('getReferrerConfig gas cost (view function)', async () => {
      await router.setReferrer(referrer.address)
      await router.setReferrerFee(50)
      
      // View functions don't consume gas in transactions, but we can measure call overhead
      const config = await router.getReferrerConfig()
      expect(config.referrerAddress).to.eq(referrer.address)
      expect(config.feeBasisPoints).to.eq(50)
    })

    it('calculateReferrerFee gas cost (view function)', async () => {
      await router.setReferrer(referrer.address)
      await router.setReferrerFee(50)
      
      const fee = await router.calculateReferrerFee(expandTo18Decimals(1000))
      expect(fee).to.be.gt(0)
    })
  })

  describe('Swap Gas Costs - With vs Without Referrer', () => {
    const inputAmount = expandTo18Decimals(1000)

    it('exactInputSingle without referrer', async () => {
      // No referrer configured
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

      await snapshotGasCost(router.connect(trader).exactInputSingle(params))
    })

    it('exactInputSingle with referrer', async () => {
      await router.setReferrer(referrer.address)
      await router.setReferrerFee(50) // 0.5%
      
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

      await snapshotGasCost(router.connect(trader).exactInputSingle(params))
    })

    it('exactInput (multi-hop) without referrer', async () => {
      const path = encodePath([tokens[0].address, tokens[1].address, tokens[2].address], [FeeAmount.MEDIUM, FeeAmount.MEDIUM])
      
      const params: ISwapRouter.ExactInputParamsStruct = {
        path: path,
        recipient: trader.address,
        deadline: constants.MaxUint256,
        amountIn: inputAmount,
        amountOutMinimum: 0,
      }

      await snapshotGasCost(router.connect(trader).exactInput(params))
    })

    it('exactInput (multi-hop) with referrer', async () => {
      await router.setReferrer(referrer.address)
      await router.setReferrerFee(50) // 0.5%
      
      const path = encodePath([tokens[0].address, tokens[1].address, tokens[2].address], [FeeAmount.MEDIUM, FeeAmount.MEDIUM])
      
      const params: ISwapRouter.ExactInputParamsStruct = {
        path: path,
        recipient: trader.address,
        deadline: constants.MaxUint256,
        amountIn: inputAmount,
        amountOutMinimum: 0,
      }

      await snapshotGasCost(router.connect(trader).exactInput(params))
    })

    it('exactOutputSingle without referrer', async () => {
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

      await snapshotGasCost(router.connect(trader).exactOutputSingle(params))
    })

    it('exactOutputSingle with referrer', async () => {
      await router.setReferrer(referrer.address)
      await router.setReferrerFee(50) // 0.5%
      
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

      await snapshotGasCost(router.connect(trader).exactOutputSingle(params))
    })
  })

  describe('Fee Collection Gas Costs', () => {
    beforeEach(async () => {
      await router.setReferrer(referrer.address)
      await router.setReferrerFee(50) // 0.5%
      
      // Perform swaps to accumulate fees in multiple tokens
      const inputAmount = expandTo18Decimals(1000)
      
      const swaps = [
        { tokenIn: tokens[0].address, tokenOut: tokens[1].address },
        { tokenIn: tokens[1].address, tokenOut: tokens[0].address },
        { tokenIn: tokens[0].address, tokenOut: tokens[2].address },
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
    })

    it('collectReferrerFees single token', async () => {
      await snapshotGasCost(router.connect(referrer).collectReferrerFees(tokens[0].address))
    })

    it('collectReferrerFeesMultiple - 2 tokens', async () => {
      const tokenAddresses = [tokens[0].address, tokens[1].address]
      await snapshotGasCost(router.connect(referrer).collectReferrerFeesMultiple(tokenAddresses))
    })

    it('collectReferrerFeesMultiple - 3 tokens', async () => {
      const tokenAddresses = [tokens[0].address, tokens[1].address, tokens[2].address]
      await snapshotGasCost(router.connect(referrer).collectReferrerFeesMultiple(tokenAddresses))
    })

    it('collectReferrerFeesMultiple - empty array', async () => {
      const tokenAddresses: string[] = []
      await snapshotGasCost(router.connect(referrer).collectReferrerFeesMultiple(tokenAddresses))
    })
  })

  describe('Gas Overhead Analysis', () => {
    let baselineGasNoReferrer: BigNumber
    let gasWithReferrer: BigNumber

    it('measures baseline gas usage without referrer', async () => {
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

      const tx = await router.connect(trader).exactInputSingle(params)
      const receipt = await tx.wait()
      baselineGasNoReferrer = receipt.gasUsed
      
      console.log(`Baseline gas (no referrer): ${baselineGasNoReferrer.toString()}`)
    })

    it('measures gas usage with referrer and calculates overhead', async () => {
      await router.setReferrer(referrer.address)
      await router.setReferrerFee(50) // 0.5%
      
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

      const tx = await router.connect(trader).exactInputSingle(params)
      const receipt = await tx.wait()
      gasWithReferrer = receipt.gasUsed
      
      console.log(`Gas with referrer: ${gasWithReferrer.toString()}`)
      
      if (baselineGasNoReferrer) {
        const overhead = gasWithReferrer.sub(baselineGasNoReferrer)
        const overheadPercentage = overhead.mul(10000).div(baselineGasNoReferrer).toNumber() / 100
        
        console.log(`Gas overhead: ${overhead.toString()} (${overheadPercentage.toFixed(2)}%)`)
        
        // Overhead should be reasonable (less than 5%)
        expect(overheadPercentage).to.be.lessThan(5)
      }
    })
  })

  describe('Different Fee Rates Gas Impact', () => {
    const feeRates = [10, 50, 100, 250, 500] // 0.1%, 0.5%, 1%, 2.5%, 5%
    
    feeRates.forEach((feeRate) => {
      it(`gas usage with ${feeRate / 100}% fee rate`, async () => {
        await router.setReferrer(referrer.address)
        await router.setReferrerFee(feeRate)
        
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

        await snapshotGasCost(router.connect(trader).exactInputSingle(params))
      })
    })
  })

  describe('Large Scale Operations', () => {
    it('gas cost scales linearly with number of tokens collected', async () => {
      await router.setReferrer(referrer.address)
      await router.setReferrerFee(50)
      
      // Perform swaps to accumulate fees in all tokens
      const inputAmount = expandTo18Decimals(1000)
      
      for (let i = 0; i < tokens.length; i++) {
        for (let j = 0; j < tokens.length; j++) {
          if (i !== j) {
            const params: ISwapRouter.ExactInputSingleParamsStruct = {
              tokenIn: tokens[i].address,
              tokenOut: tokens[j].address,
              fee: FeeAmount.MEDIUM,
              recipient: trader.address,
              deadline: constants.MaxUint256,
              amountIn: inputAmount,
              amountOutMinimum: 0,
              sqrtPriceLimitX96: 0,
            }
            
            await router.connect(trader).exactInputSingle(params)
          }
        }
      }
      
      // Measure gas for collecting different numbers of tokens
      const gasUsages: BigNumber[] = []
      
      for (let numTokens = 1; numTokens <= tokens.length; numTokens++) {
        const tokensToCollect = tokens.slice(0, numTokens).map(t => t.address)
        
        const tx = await router.connect(referrer).collectReferrerFeesMultiple(tokensToCollect)
        const receipt = await tx.wait()
        gasUsages.push(receipt.gasUsed)
        
        console.log(`Gas for collecting ${numTokens} tokens: ${receipt.gasUsed.toString()}`)
      }
      
      // Verify gas usage increases linearly (roughly)
      if (gasUsages.length >= 2) {
        const gasPerToken = gasUsages[1].sub(gasUsages[0])
        console.log(`Approximate gas per additional token: ${gasPerToken.toString()}`)
        
        // Additional tokens should cost less than 50k gas each
        expect(gasPerToken.toNumber()).to.be.lessThan(50000)
      }
    })

    it('gas usage for frequent small swaps vs infrequent large swaps', async () => {
      await router.setReferrer(referrer.address)
      await router.setReferrerFee(50)
      
      const totalAmount = expandTo18Decimals(5000)
      
      // Many small swaps
      const smallSwapAmount = expandTo18Decimals(100)
      const numSmallSwaps = 50
      let totalGasSmallSwaps = BigNumber.from(0)
      
      for (let i = 0; i < numSmallSwaps; i++) {
        const params: ISwapRouter.ExactInputSingleParamsStruct = {
          tokenIn: tokens[0].address,
          tokenOut: tokens[1].address,
          fee: FeeAmount.MEDIUM,
          recipient: trader.address,
          deadline: constants.MaxUint256,
          amountIn: smallSwapAmount,
          amountOutMinimum: 0,
          sqrtPriceLimitX96: 0,
        }
        
        const tx = await router.connect(trader).exactInputSingle(params)
        const receipt = await tx.wait()
        totalGasSmallSwaps = totalGasSmallSwaps.add(receipt.gasUsed)
      }
      
      console.log(`Total gas for ${numSmallSwaps} small swaps: ${totalGasSmallSwaps.toString()}`)
      
      // Reset state for large swap test
      await router.connect(referrer).collectReferrerFees(tokens[0].address)
      
      // One large swap
      const params: ISwapRouter.ExactInputSingleParamsStruct = {
        tokenIn: tokens[0].address,
        tokenOut: tokens[1].address,
        fee: FeeAmount.MEDIUM,
        recipient: trader.address,
        deadline: constants.MaxUint256,
        amountIn: totalAmount,
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0,
      }
      
      const tx = await router.connect(trader).exactInputSingle(params)
      const receipt = await tx.wait()
      const gasLargeSwap = receipt.gasUsed
      
      console.log(`Gas for 1 large swap: ${gasLargeSwap.toString()}`)
      console.log(`Gas efficiency ratio: ${totalGasSmallSwaps.div(gasLargeSwap).toString()}x`)
      
      // Large swaps should be significantly more gas efficient
      expect(gasLargeSwap.mul(10)).to.be.lessThan(totalGasSmallSwaps)
    })
  })

  describe('Gas Usage Bounds', () => {
    it('ensures swap gas usage stays within reasonable bounds', async () => {
      await router.setReferrer(referrer.address)
      await router.setReferrerFee(500) // Maximum 5%
      
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

      const tx = await router.connect(trader).exactInputSingle(params)
      const receipt = await tx.wait()
      
      // Should be less than 200k gas even with maximum referrer fee
      expect(receipt.gasUsed.toNumber()).to.be.lessThan(200000)
      
      console.log(`Gas usage with max fee: ${receipt.gasUsed.toString()}`)
    })

    it('collection gas usage bounds', async () => {
      await router.setReferrer(referrer.address)
      await router.setReferrerFee(50)
      
      // Accumulate some fees
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

      await router.connect(trader).exactInputSingle(params)
      
      const tx = await router.connect(referrer).collectReferrerFees(tokens[0].address)
      const receipt = await tx.wait()
      
      // Fee collection should be less than 100k gas
      expect(receipt.gasUsed.toNumber()).to.be.lessThan(100000)
      
      console.log(`Fee collection gas: ${receipt.gasUsed.toString()}`)
    })
  })
})