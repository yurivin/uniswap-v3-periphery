import { ethers } from 'hardhat'
import { Contract, Wallet } from 'ethers'
import fs from 'fs'
import path from 'path'

// Deployment configuration interface
interface DeploymentConfig {
  network: string
  factoryAddress: string
  weth9Address: string
  initialReferrer?: string
  initialReferrerFee?: number // basis points (0-500)
  transferOwnershipTo?: string
  gasPrice?: string
  gasLimit?: number
  verify?: boolean
}

// Network configurations
const NETWORK_CONFIGS: { [key: string]: Partial<DeploymentConfig> } = {
  mainnet: {
    factoryAddress: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    weth9Address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  },
  goerli: {
    factoryAddress: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    weth9Address: '0xB4FBF271143F4FBf85FD3c8AC6AD1bB8cD21a99EC',
  },
  polygon: {
    factoryAddress: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    weth9Address: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', // WMATIC
  },
  arbitrum: {
    factoryAddress: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    weth9Address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
  },
  optimism: {
    factoryAddress: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    weth9Address: '0x4200000000000000000000000000000000000006',
  },
  base: {
    factoryAddress: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
    weth9Address: '0x4200000000000000000000000000000000000006',
  },
  // Local/test networks
  hardhat: {
    factoryAddress: '0x0000000000000000000000000000000000000000', // Will be set during deployment
    weth9Address: '0x0000000000000000000000000000000000000000', // Will be set during deployment
  },
  localhost: {
    factoryAddress: '0x0000000000000000000000000000000000000000', // Will be set during deployment
    weth9Address: '0x0000000000000000000000000000000000000000', // Will be set during deployment
  },
}

// Deployment result interface
interface DeploymentResult {
  swapRouter: string
  factory: string
  weth9: string
  deployer: string
  owner: string
  referrer: string
  referrerFee: number
  blockNumber: number
  transactionHash: string
  gasUsed: string
  deploymentCost: string
  timestamp: number
}

class SwapRouterReferrerDeployer {
  private config: DeploymentConfig
  private deployer: Wallet

  constructor(config: DeploymentConfig) {
    this.config = config
  }

  async deploy(): Promise<DeploymentResult> {
    console.log('🚀 Starting SwapRouter with Referrer deployment...')
    console.log(`Network: ${this.config.network}`)
    console.log(`Factory: ${this.config.factoryAddress}`)
    console.log(`WETH9: ${this.config.weth9Address}`)
    console.log('')

    // Get deployer
    const [deployer] = await ethers.getSigners()
    this.deployer = deployer
    console.log(`Deployer: ${deployer.address}`)
    console.log(`Balance: ${ethers.utils.formatEther(await deployer.getBalance())} ETH`)
    console.log('')

    // Validate configuration
    await this.validateConfig()

    // Deploy SwapRouter
    console.log('📦 Deploying SwapRouter with Referrer functionality...')
    const swapRouter = await this.deploySwapRouter()
    console.log(`SwapRouter deployed at: ${swapRouter.address}`)
    console.log('')

    // Configure referrer settings
    await this.configureReferrer(swapRouter)

    // Transfer ownership if specified
    await this.transferOwnership(swapRouter)

    // Get deployment info
    const deploymentTx = swapRouter.deployTransaction
    const receipt = await deploymentTx.wait()

    // Save deployment info
    const result: DeploymentResult = {
      swapRouter: swapRouter.address,
      factory: this.config.factoryAddress,
      weth9: this.config.weth9Address,
      deployer: deployer.address,
      owner: await swapRouter.owner(),
      referrer: await swapRouter.referrer(),
      referrerFee: await swapRouter.referrerFeeBasisPoints(),
      blockNumber: receipt.blockNumber,
      transactionHash: receipt.transactionHash,
      gasUsed: receipt.gasUsed.toString(),
      deploymentCost: receipt.gasUsed.mul(deploymentTx.gasPrice || 0).toString(),
      timestamp: Math.floor(Date.now() / 1000),
    }

    await this.saveDeploymentInfo(result)
    await this.verifyContract(result)

    console.log('✅ Deployment completed successfully!')
    console.log('')
    this.printSummary(result)

    return result
  }

  private async validateConfig(): Promise<void> {
    console.log('🔍 Validating deployment configuration...')

    // Check factory address
    if (!ethers.utils.isAddress(this.config.factoryAddress)) {
      throw new Error(`Invalid factory address: ${this.config.factoryAddress}`)
    }

    // Check WETH9 address  
    if (!ethers.utils.isAddress(this.config.weth9Address)) {
      throw new Error(`Invalid WETH9 address: ${this.config.weth9Address}`)
    }

    // Check initial referrer if provided
    if (this.config.initialReferrer && !ethers.utils.isAddress(this.config.initialReferrer)) {
      throw new Error(`Invalid initial referrer address: ${this.config.initialReferrer}`)
    }

    // Check referrer fee
    if (this.config.initialReferrerFee !== undefined) {
      if (this.config.initialReferrerFee < 0 || this.config.initialReferrerFee > 500) {
        throw new Error(`Invalid referrer fee: ${this.config.initialReferrerFee}. Must be 0-500 basis points (0-5%)`)
      }
    }

    // Check transfer ownership address
    if (this.config.transferOwnershipTo && !ethers.utils.isAddress(this.config.transferOwnershipTo)) {
      throw new Error(`Invalid ownership transfer address: ${this.config.transferOwnershipTo}`)
    }

    // For non-test networks, verify factory exists
    if (!['hardhat', 'localhost'].includes(this.config.network)) {
      try {
        const factoryCode = await ethers.provider.getCode(this.config.factoryAddress)
        if (factoryCode === '0x') {
          throw new Error(`Factory contract not found at ${this.config.factoryAddress}`)
        }
      } catch (error) {
        console.warn(`Warning: Could not verify factory contract: ${error.message}`)
      }
    }

    console.log('✅ Configuration validated')
    console.log('')
  }

  private async deploySwapRouter(): Promise<Contract> {
    const SwapRouter = await ethers.getContractFactory('SwapRouter')
    
    const deployOptions: any = {
      gasLimit: this.config.gasLimit,
    }

    if (this.config.gasPrice) {
      deployOptions.gasPrice = ethers.utils.parseUnits(this.config.gasPrice, 'gwei')
    }

    const swapRouter = await SwapRouter.deploy(
      this.config.factoryAddress,
      this.config.weth9Address,
      deployOptions
    )

    await swapRouter.deployed()
    return swapRouter
  }

  private async configureReferrer(swapRouter: Contract): Promise<void> {
    console.log('⚙️  Configuring referrer settings...')

    const transactions = []

    // Set initial referrer if provided
    if (this.config.initialReferrer) {
      console.log(`Setting initial referrer: ${this.config.initialReferrer}`)
      const tx = await swapRouter.setReferrer(this.config.initialReferrer)
      transactions.push(tx)
      await tx.wait()
      console.log(`✅ Referrer set to: ${this.config.initialReferrer}`)
    }

    // Set initial referrer fee if provided
    if (this.config.initialReferrerFee !== undefined) {
      console.log(`Setting initial referrer fee: ${this.config.initialReferrerFee} basis points (${this.config.initialReferrerFee / 100}%)`)
      const tx = await swapRouter.setReferrerFee(this.config.initialReferrerFee)
      transactions.push(tx)
      await tx.wait()
      console.log(`✅ Referrer fee set to: ${this.config.initialReferrerFee} basis points`)
    }

    if (transactions.length === 0) {
      console.log('No referrer configuration provided, using defaults (disabled)')
    }

    console.log('')
  }

  private async transferOwnership(swapRouter: Contract): Promise<void> {
    if (!this.config.transferOwnershipTo) {
      console.log('No ownership transfer specified, deployer remains owner')
      return
    }

    console.log('👑 Transferring ownership...')
    console.log(`From: ${this.deployer.address}`)
    console.log(`To: ${this.config.transferOwnershipTo}`)

    const tx = await swapRouter.transferOwnership(this.config.transferOwnershipTo)
    await tx.wait()

    console.log('✅ Ownership transferred successfully')
    console.log('')
  }

  private async saveDeploymentInfo(result: DeploymentResult): Promise<void> {
    const deploymentsDir = path.join(__dirname, '..', 'deployments')
    if (!fs.existsSync(deploymentsDir)) {
      fs.mkdirSync(deploymentsDir, { recursive: true })
    }

    const filename = `${this.config.network}-swaprouter-referrer-${Date.now()}.json`
    const filepath = path.join(deploymentsDir, filename)

    const deploymentInfo = {
      ...result,
      config: this.config,
      deployedAt: new Date().toISOString(),
    }

    fs.writeFileSync(filepath, JSON.stringify(deploymentInfo, null, 2))
    console.log(`📄 Deployment info saved to: ${filepath}`)

    // Also save as latest
    const latestFilepath = path.join(deploymentsDir, `${this.config.network}-swaprouter-referrer-latest.json`)
    fs.writeFileSync(latestFilepath, JSON.stringify(deploymentInfo, null, 2))
    console.log(`📄 Latest deployment info saved to: ${latestFilepath}`)
  }

  private async verifyContract(result: DeploymentResult): Promise<void> {
    if (!this.config.verify || ['hardhat', 'localhost'].includes(this.config.network)) {
      return
    }

    console.log('🔍 Verifying contract on block explorer...')
    
    try {
      // Note: This would require proper hardhat-etherscan plugin configuration
      console.log('Contract verification would be performed here with:')
      console.log(`Address: ${result.swapRouter}`)
      console.log(`Constructor args: [${this.config.factoryAddress}, ${this.config.weth9Address}]`)
      console.log('Please verify manually or configure hardhat-etherscan plugin')
    } catch (error) {
      console.warn(`Warning: Contract verification failed: ${error.message}`)
    }
  }

  private printSummary(result: DeploymentResult): void {
    console.log('📋 DEPLOYMENT SUMMARY')
    console.log('=' .repeat(50))
    console.log(`Network: ${this.config.network}`)
    console.log(`SwapRouter: ${result.swapRouter}`)
    console.log(`Factory: ${result.factory}`)
    console.log(`WETH9: ${result.weth9}`)
    console.log(`Owner: ${result.owner}`)
    console.log(`Referrer: ${result.referrer || 'Not set'}`)
    console.log(`Referrer Fee: ${result.referrerFee} basis points (${result.referrerFee / 100}%)`)
    console.log(`Block: ${result.blockNumber}`)
    console.log(`Gas Used: ${result.gasUsed}`)
    console.log(`Deployment Cost: ${ethers.utils.formatEther(result.deploymentCost)} ETH`)
    console.log('=' .repeat(50))
    console.log('')
    console.log('🎯 NEXT STEPS:')
    console.log('1. Verify the contract on block explorer (if not done automatically)')
    console.log('2. Update frontend integrations to use the new router address')
    console.log('3. Test the referrer functionality with small amounts first')
    console.log('4. Monitor gas usage and performance')
    console.log('5. Set up analytics to track referrer fees')
    console.log('')
    console.log('💡 MANAGEMENT COMMANDS:')
    console.log(`Set referrer: router.setReferrer("0x...")`)
    console.log(`Set fee: router.setReferrerFee(50) // 0.5%`)
    console.log(`Transfer ownership: router.transferOwnership("0x...")`)
    console.log(`Collect fees: router.collectReferrerFees("tokenAddress")`)
  }
}

// Main deployment function
async function main() {
  const networkName = process.env.HARDHAT_NETWORK || 'hardhat'
  
  // Get network-specific config
  const networkConfig = NETWORK_CONFIGS[networkName] || {}
  
  // Build deployment configuration
  const config: DeploymentConfig = {
    network: networkName,
    factoryAddress: process.env.FACTORY_ADDRESS || networkConfig.factoryAddress || '',
    weth9Address: process.env.WETH9_ADDRESS || networkConfig.weth9Address || '',
    initialReferrer: process.env.INITIAL_REFERRER,
    initialReferrerFee: process.env.INITIAL_REFERRER_FEE ? parseInt(process.env.INITIAL_REFERRER_FEE) : undefined,
    transferOwnershipTo: process.env.TRANSFER_OWNERSHIP_TO,
    gasPrice: process.env.GAS_PRICE,
    gasLimit: process.env.GAS_LIMIT ? parseInt(process.env.GAS_LIMIT) : undefined,
    verify: process.env.VERIFY === 'true',
  }

  // Validate required config
  if (!config.factoryAddress) {
    throw new Error('Factory address is required. Set FACTORY_ADDRESS environment variable.')
  }
  if (!config.weth9Address) {
    throw new Error('WETH9 address is required. Set WETH9_ADDRESS environment variable.')
  }

  // Deploy
  const deployer = new SwapRouterReferrerDeployer(config)
  await deployer.deploy()
}

// Deployment script for different scenarios
export async function deployForMainnet(
  factoryAddress: string,
  weth9Address: string,
  referrer?: string,
  referrerFee?: number,
  newOwner?: string
) {
  const config: DeploymentConfig = {
    network: 'mainnet',
    factoryAddress,
    weth9Address,
    initialReferrer: referrer,
    initialReferrerFee: referrerFee,
    transferOwnershipTo: newOwner,
    verify: true,
  }

  const deployer = new SwapRouterReferrerDeployer(config)
  return await deployer.deploy()
}

export async function deployForTestnet(
  network: string,
  factoryAddress: string,
  weth9Address: string,
  referrer?: string,
  referrerFee?: number
) {
  const config: DeploymentConfig = {
    network,
    factoryAddress,
    weth9Address,
    initialReferrer: referrer,
    initialReferrerFee: referrerFee || 50, // Default 0.5% for testing
    verify: true,
  }

  const deployer = new SwapRouterReferrerDeployer(config)
  return await deployer.deploy()
}

export async function deployForDevelopment() {
  // For local development, factory and WETH addresses would be deployed first
  const config: DeploymentConfig = {
    network: 'localhost',
    factoryAddress: '0x0000000000000000000000000000000000000000', // Would be set after factory deployment
    weth9Address: '0x0000000000000000000000000000000000000000', // Would be set after WETH deployment
    initialReferrer: '0x0000000000000000000000000000000000000001', // Test referrer
    initialReferrerFee: 50, // 0.5% for testing
    verify: false,
  }

  const deployer = new SwapRouterReferrerDeployer(config)
  return await deployer.deploy()
}

// Run if called directly
if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Deployment failed:', error)
      process.exit(1)
    })
}

export { SwapRouterReferrerDeployer, DeploymentConfig, DeploymentResult }