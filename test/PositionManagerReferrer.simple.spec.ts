import { expect } from 'chai'
import { ethers } from 'hardhat'
import { Contract } from 'ethers'

describe('PositionManager Referrer Functionality', () => {
  let positionManager: Contract
  let owner: any, referrer: any, other: any

  beforeEach(async () => {
    const signers = await ethers.getSigners()
    ;[owner, referrer, other] = signers

    // Deploy PositionManager
    const factory = await ethers.getContractFactory('NonfungiblePositionManager')
    positionManager = await factory.deploy(
      '0x1F98431c8aD98523631AE4a59f267346ea31F984', // Factory address (mock)
      '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH9 address (mock)
      '0x91ae842A5Ffd8d12023116943e72A606179294f3'  // Token descriptor (mock)
    )
    await positionManager.deployed()
  })

  describe('Referrer Configuration', () => {
    it('should initialize with zero referrer and fee rate', async () => {
      expect(await positionManager.referrer()).to.equal(ethers.constants.AddressZero)
      expect(await positionManager.referrerFeeRate()).to.equal(0)
    })

    it('should allow owner to set referrer', async () => {
      await positionManager.connect(owner).setReferrer(referrer.address)
      expect(await positionManager.referrer()).to.equal(referrer.address)
    })

    it('should allow owner to set referrer fee rate', async () => {
      await positionManager.connect(owner).setReferrerFeeRate(250) // 2.5%
      expect(await positionManager.referrerFeeRate()).to.equal(250)
    })

    it('should revert if fee rate is too high', async () => {
      await expect(
        positionManager.connect(owner).setReferrerFeeRate(600) // 6% > 5% max
      ).to.be.revertedWith('Fee rate too high')
    })

    it('should revert if non-owner tries to set referrer', async () => {
      await expect(
        positionManager.connect(other).setReferrer(referrer.address)
      ).to.be.revertedWith('Ownable: caller is not the owner')
    })

    it('should return correct referrer config', async () => {
      await positionManager.connect(owner).setReferrer(referrer.address)
      await positionManager.connect(owner).setReferrerFeeRate(100) // 1%
      
      const [returnedReferrer, returnedFeeRate] = await positionManager.getReferrerConfig()
      expect(returnedReferrer).to.equal(referrer.address)
      expect(returnedFeeRate).to.equal(100)
    })

    it('should calculate referrer fee correctly', async () => {
      await positionManager.connect(owner).setReferrer(referrer.address)
      await positionManager.connect(owner).setReferrerFeeRate(250) // 2.5%
      
      const amount = ethers.utils.parseEther('100')
      const expectedFee = amount.mul(250).div(10000) // 2.5 ETH
      const calculatedFee = await positionManager.calculateReferrerFee(amount)
      
      expect(calculatedFee).to.equal(expectedFee)
    })

    it('should return zero fee when no referrer set', async () => {
      const amount = ethers.utils.parseEther('100')
      const calculatedFee = await positionManager.calculateReferrerFee(amount)
      expect(calculatedFee).to.equal(0)
    })

    it('should emit events when configuration changes', async () => {
      await expect(positionManager.connect(owner).setReferrer(referrer.address))
        .to.emit(positionManager, 'ReferrerChanged')
        .withArgs(ethers.constants.AddressZero, referrer.address)

      await expect(positionManager.connect(owner).setReferrerFeeRate(100))
        .to.emit(positionManager, 'ReferrerFeeRateChanged')
        .withArgs(0, 100)
    })
  })
})