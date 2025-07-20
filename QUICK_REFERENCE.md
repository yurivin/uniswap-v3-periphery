# SwapRouter Referrer - Quick Reference Guide

## 🚀 **Quick Start**

### Deploy and Configure
```solidity
// Deploy SwapRouter
SwapRouter router = new SwapRouter(factoryAddress, weth9Address);

// Configure referrer (owner only)
router.setReferrer(0x742d35Cc6634C0532925a3b8D58d4c8e2aDa8b);
router.setReferrerFee(50); // 0.5%
```

### Use in Swaps
```solidity
// Normal swap - referrer fees handled automatically
router.exactInputSingle({
    tokenIn: USDC,
    tokenOut: DAI,
    fee: 3000,
    recipient: user,
    deadline: block.timestamp,
    amountIn: 1000e6,
    amountOutMinimum: 995e18,
    sqrtPriceLimitX96: 0
});
```

### Collect Fees
```solidity
// Referrer collects accumulated fees
uint256 fees = router.collectReferrerFees(USDC);

// Batch collection for multiple tokens
address[] memory tokens = [USDC, DAI, WETH];
uint256[] memory amounts = router.collectReferrerFeesMultiple(tokens);
```

---

## 📋 **Function Reference**

### Owner Functions (Access Controlled)
```solidity
function setReferrer(address _referrer) external onlyOwner
function setReferrerFee(uint24 _feeBasisPoints) external onlyOwner  // Max 500 (5%)
function transferOwnership(address newOwner) external onlyOwner
```

### Public View Functions
```solidity
function getReferrerConfig() external view returns (address referrer, uint24 feeBasisPoints)
function calculateReferrerFee(uint256 amount) external view returns (uint256 fee)
function referrerFees(address referrer, address token) external view returns (uint256 amount)
function owner() external view returns (address)
```

### Fee Collection Functions
```solidity
function collectReferrerFees(address token) external returns (uint256 amount)
function collectReferrerFeesMultiple(address[] tokens) external returns (uint256[] amounts)
```

### Original Swap Functions (Enhanced with Referrer Support)
```solidity
function exactInputSingle(ExactInputSingleParams params) external payable returns (uint256 amountOut)
function exactInput(ExactInputParams params) external payable returns (uint256 amountOut)
function exactOutputSingle(ExactOutputSingleParams params) external payable returns (uint256 amountIn)
function exactOutput(ExactOutputParams params) external payable returns (uint256 amountIn)
```

---

## 📊 **Fee Calculation Examples**

| Input Amount | Fee Rate | Referrer Fee | Amount Swapped |
|--------------|----------|--------------|----------------|
| 1,000 USDC   | 0.5%     | 5 USDC       | 995 USDC       |
| 1,000 USDC   | 1.0%     | 10 USDC      | 990 USDC       |
| 1,000 USDC   | 2.5%     | 25 USDC      | 975 USDC       |
| 1,000 USDC   | 5.0%     | 50 USDC      | 950 USDC       |

---

## 🔧 **Configuration Examples**

### Production Setup
```solidity
// Mainnet deployment
SwapRouter router = new SwapRouter(
    0x1F98431c8aD98523631AE4a59f267346ea31F984, // Factory
    0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2  // WETH9
);

router.setReferrer(0x742d35Cc6634C0532925a3b8D58d4c8e2aDa8b);
router.setReferrerFee(30); // 0.3%
router.transferOwnership(protocolOwner);
```

### Testnet Setup
```solidity
// Goerli deployment
SwapRouter router = new SwapRouter(
    0x1F98431c8aD98523631AE4a59f267346ea31F984, // Factory
    0xB4FBF271143F4FBf85FD3c8AC6AD1bB8cD21a99EC  // WETH9
);

router.setReferrer(testReferrer);
router.setReferrerFee(100); // 1% for testing
```

### Disable Referrer
```solidity
// Disable referrer functionality
router.setReferrer(address(0));
// or
router.setReferrerFee(0);
```

---

## 📝 **Event Reference**

```solidity
// Referrer configuration events
event ReferrerChanged(address indexed oldReferrer, address indexed newReferrer);
event ReferrerFeeChanged(uint24 oldFee, uint24 newFee);

// Fee handling events
event ReferrerFeeAccumulated(address indexed referrer, address indexed token, uint256 amount);
event ReferrerFeesCollected(address indexed referrer, address indexed token, uint256 amount);

// Ownership events (from OpenZeppelin)
event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
```

---

## ⚡ **Performance Metrics**

### Gas Usage
- **Configuration**: ~25-45k gas per operation
- **Swap Overhead**: ~3-5% increase when referrer enabled
- **Fee Collection**: ~50-80k gas per token
- **Batch Collection**: Linear scaling (~20-30k per additional token)

### Contract Size
- **Increase**: ~3-4KB due to referrer functionality
- **Total Size**: ~15-16KB (within deployment limits)

---

## 🚨 **Important Notes**

### Security
- ✅ **Reentrancy Protected** - Uses OpenZeppelin ReentrancyGuard
- ✅ **Access Controlled** - Owner-only configuration functions
- ✅ **Fee Limited** - Maximum 5% fee rate enforced
- ✅ **Safe Math** - Overflow protection in all calculations

### Compatibility
- ✅ **Backwards Compatible** - Existing integrations work unchanged
- ✅ **Interface Preserved** - All original functions available
- ✅ **Event Compatible** - Original events unchanged when referrer disabled

### Best Practices
- 🎯 Set reasonable fee rates (typically 0.3% - 1.0%)
- 🔐 Transfer ownership to a secure multisig wallet
- 📊 Monitor fee accumulation and collection regularly
- ⚡ Use batch collection for multiple tokens to save gas

---

## 🛠️ **Development Commands**

### Testing
```bash
# Run all tests
npm test

# Test referrer functionality only
npx hardhat test test/SwapRouterReferrer*.spec.ts

# Test backwards compatibility
npx hardhat test test/SwapRouterBackwardsCompatibility.spec.ts

# Gas analysis
npx hardhat test test/SwapRouterReferrerGas.spec.ts
```

### Deployment
```bash
# Set environment variables
export FACTORY_ADDRESS="0x1F98431c8aD98523631AE4a59f267346ea31F984"
export WETH9_ADDRESS="0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"
export INITIAL_REFERRER="0x742d35Cc6634C0532925a3b8D58d4c8e2aDa8b"
export INITIAL_REFERRER_FEE="50"

# Deploy to network
npx hardhat run scripts/deploy-swap-router-referrer.ts --network mainnet

# Verify deployment
export CONTRACT_ADDRESS="0x...DeployedAddress"
npx hardhat run scripts/verify-swap-router-referrer.ts --network mainnet
```

### Compilation
```bash
# Compile all contracts
npm run compile

# Clean and recompile
npx hardhat clean && npx hardhat compile
```

---

## 📚 **Further Reading**

- **[TESTING_AND_DEPLOYMENT_GUIDE.md](./TESTING_AND_DEPLOYMENT_GUIDE.md)** - Complete testing and deployment guide
- **[swaprouter-referrer-router-level-implementation.md](./swaprouter-referrer-router-level-implementation.md)** - Technical implementation details  
- **[TEST_COVERAGE_ANALYSIS.md](./TEST_COVERAGE_ANALYSIS.md)** - Comprehensive test coverage analysis
- **[CHANGELOG.md](./CHANGELOG.md)** - Complete changelog of all modifications

---

## 🆘 **Troubleshooting**

### Common Issues

**"Ownable: caller is not the owner"**
- Only the contract owner can call `setReferrer` and `setReferrerFee`
- Check ownership with `router.owner()`

**"Fee too high"**
- Maximum fee rate is 500 basis points (5%)
- Use values 0-500 for `setReferrerFee`

**"No fees to collect"**
- Referrer must have accumulated fees first
- Check balance with `router.referrerFees(referrer, token)`

**Balance check failures in tests**
- Make sure to disable referrer or collect fees before balance assertions
- See updated `SwapRouter.spec.ts` for example

### Getting Help

1. **Check documentation** - Review the guides listed above
2. **Run tests** - Use the comprehensive test suite to validate setup
3. **Verify deployment** - Use the verification script to check contract state
4. **Review events** - Monitor blockchain events for fee operations