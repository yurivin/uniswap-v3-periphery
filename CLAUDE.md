# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Implementation Status

### ✅ COMPLETED - SwapRouter Referrer Fees
- **Status**: Production ready and fully tested with comprehensive test coverage
- **Approach**: Periphery-only implementation (no core contract changes needed)
- **Features**: Owner-controlled referrer management, accumulate-then-collect pattern, 0-5% fee rates
- **Testing**: 6 comprehensive test files with 100+ test cases covering security, integration, and gas analysis
- **Documentation**: Complete with deployment guides and technical implementation details

### 🚧 IN PROGRESS - Position Manager Referrer Fees  
- **Status**: PositionManager implementation complete, pool integration pending
- **Approach**: Two-level storage architecture (PositionManager + Pool coordination)
- **Architecture**: PositionManager stores referrer config, Pool stores positionManager address per position
- **Implementation**: Referrer functions added to PositionManager with owner-only access control
- **Dynamic Lookup**: Pool calls `positionManager.getReferrerConfig()` for real-time fee rates
- **Current State**: PositionManager complete, requires core pool contract modifications

## Build Commands

- `npm run compile` - Compile all Solidity contracts using Hardhat
- `npm run test` - Run the full test suite

## Testing

Tests are located in the `test/` directory and use Hardhat with Waffle and Chai. The repository includes comprehensive testing for original functionality and **completed SwapRouter referrer features**.

### Test Organization

**Core Contract Tests:**
- `SwapRouter.spec.ts` - Original SwapRouter functionality tests
- `NonfungiblePositionManager.spec.ts` - Position manager tests (original functionality only)
- `SwapRouter.gas.spec.ts` - Gas usage analysis

**SwapRouter Referrer Functionality Tests (COMPLETED):**
- `SwapRouterReferrer.spec.ts` - Unit tests for referrer functionality
- `SwapRouterReferrerIntegration.spec.ts` - Integration tests with swap operations
- `SwapRouterReferrerSecurity.spec.ts` - Security and attack vector prevention tests
- `SwapRouterReferrerGas.spec.ts` - Gas usage analysis for referrer features
- `SwapRouterReferrerCoreIntegration.spec.ts` - Deep integration with existing features
- `SwapRouterBackwardsCompatibility.spec.ts` - Backwards compatibility validation

**Library Tests:**
- `Path.spec.ts`, `PoolAddress.spec.ts`, etc. - Library functionality tests

### Running Tests

Run all tests:
```bash
npm test
```

Run specific test suites:
```bash
# Original SwapRouter tests
npx hardhat test test/SwapRouter.spec.ts

# Referrer functionality tests
npx hardhat test test/SwapRouterReferrer*.spec.ts

# Single test file
npx hardhat test test/SwapRouterReferrerIntegration.spec.ts
```

## Architecture Overview

This is the **Uniswap V3 Periphery** repository containing smart contracts that interact with the Uniswap V3 Core protocol. The periphery contracts provide user-friendly interfaces and additional functionality on top of the core pool contracts.

### Key Contracts

**Core Router Contracts:**
- `SwapRouter.sol` - Main entry point for token swaps with **COMPLETED** referrer fee functionality
  - Supports exact input/output, single/multi-hop swaps
  - Includes secure referrer fee system with accumulate-then-collect pattern
  - Owner-controlled referrer management with 0-5% fee rates
  - Full backwards compatibility when referrer functionality is disabled
- `NonfungiblePositionManager.sol` - Manages liquidity positions as ERC721 NFTs (original functionality only)

**Supporting Contracts:**
- `NonfungibleTokenPositionDescriptor.sol` - Generates SVG metadata for position NFTs
- `V3Migrator.sol` - Migrates liquidity from Uniswap V2 to V3

**Quoter Contracts** (`contracts/lens/`):
- `Quoter.sol` - Returns swap quotes without executing trades
- `QuoterV2.sol` - Enhanced quoter with gas optimizations
- `TickLens.sol` - Provides tick data for pools

### Base Contract Architecture

Contracts use a modular inheritance pattern with base contracts in `contracts/base/`:

- `PeripheryImmutableState` - Stores factory and WETH addresses
- `PeripheryValidation` - Adds deadline validation modifier
- `PeripheryPayments`/`PeripheryPaymentsWithFee` - Handles ETH/WETH and token transfers
- `Multicall` - Enables batching multiple function calls
- `SelfPermit` - Allows permit-based approvals in the same transaction
- `LiquidityManagement` - Core liquidity position logic
- `PoolInitializer` - Creates new pools if they don't exist

**SwapRouter Enhanced Inheritance:**
- Inherits from OpenZeppelin `Ownable` for access control
- Inherits from OpenZeppelin `ReentrancyGuard` for security
- Maintains all original base contract functionality

### Library Architecture

Key libraries in `contracts/libraries/`:
- `Path.sol` - Encodes/decodes swap paths for multi-hop swaps
- `PoolAddress.sol` - Computes pool addresses deterministically using CREATE2
- `CallbackValidation.sol` - Validates callbacks from core pools to prevent attacks
- `LiquidityAmounts.sol` - Calculates token amounts for liquidity operations
- `PositionKey.sol` - Generates keys for liquidity positions

### Core Pool Integration

The periphery contracts integrate seamlessly with Uniswap V3 Core pools through:

**Direct Pool Operations:**
- `NonfungiblePositionManager` calls core pool functions: `mint()`, `burn()`, `collect()`, `positions()`
- `SwapRouter` uses pool's `swap()` function with callback validation
- All pool addresses computed deterministically via `PoolAddress.computeAddress()`

**Secure Callback System:**
- Periphery contracts implement core callback interfaces (`IUniswapV3MintCallback`, `IUniswapV3SwapCallback`)
- `CallbackValidation.verifyCallback()` ensures only authentic pools can trigger callbacks
- Prevents callback-based attacks by validating `msg.sender` matches computed pool address

**Fee Growth Synchronization:**
- Position manager syncs with pool's fee growth trackers (`feeGrowthInside0LastX128`, `feeGrowthInside1LastX128`)
- Uses core libraries (`FullMath`, `FixedPoint128`) for precise fee calculations
- Maintains position state consistency with underlying pool state

## Development Notes

**Solidity Version:** 0.7.6 with ABIEncoderV2
**Framework:** Hardhat with TypeScript

**Compiler Settings:**
- Most contracts: 1,000,000 optimizer runs (for deployment efficiency)
- `NonfungiblePositionManager`: 2,000 runs (size optimization)
- NFT descriptor contracts: 1,000 runs (size optimization)

**Key Dependencies:**
- `@uniswap/v3-core` - Core pool contracts and libraries
- `@openzeppelin/contracts` v3.4.2 - For ERC20, ERC721, Ownable, ReentrancyGuard

**Testing Framework:**
- Hardhat + Ethers.js + Waffle + Chai
- Snapshot testing for gas costs and complex outputs
- Mock contracts in `contracts/test/` for testing scenarios
- Comprehensive security testing for referrer functionality
- Backwards compatibility validation

## SwapRouter Referrer Functionality

The SwapRouter has been enhanced with secure referrer fee functionality:

### Key Features
- **Owner-controlled referrer management** - Only contract owner can set referrer and fee rates
- **Configurable fee rates** - 0 to 500 basis points (0% to 5%)
- **Accumulate-then-collect pattern** - Secure fee handling prevents reentrancy attacks
- **Multi-token support** - Referrers can collect fees for multiple tokens
- **Gas efficient** - Minimal overhead (~3-5% gas increase per swap)
- **Backwards compatible** - Existing integrations work unchanged when referrer disabled

### Core Functions
```solidity
// Owner-only configuration
function setReferrer(address _referrer) external onlyOwner
function setReferrerFee(uint24 _feeBasisPoints) external onlyOwner

// Public view functions
function getReferrerConfig() external view returns (address, uint24)
function calculateReferrerFee(uint256 amount) external view returns (uint256)
function referrerFees(address referrer, address token) external view returns (uint256)

// Fee collection
function collectReferrerFees(address token) external returns (uint256)
function collectReferrerFeesMultiple(address[] tokens) external returns (uint256[])
```

### Usage Examples
```solidity
// Configure referrer (owner only)
router.setReferrer(0x742d35Cc6634C0532925a3b8D58d4c8e2aDa8b);
router.setReferrerFee(50); // 0.5%

// Normal swaps work unchanged - fees automatically handled
router.exactInputSingle({
    tokenIn: tokenA,
    tokenOut: tokenB,
    fee: 3000,
    recipient: user,
    deadline: block.timestamp,
    amountIn: 1000e18,
    amountOutMinimum: 0,
    sqrtPriceLimitX96: 0
});

// Referrer collects accumulated fees
uint256 collected = router.collectReferrerFees(tokenA);
```

## Deployment and Scripts

**Deployment Scripts:**
- `scripts/deploy-swap-router-referrer.ts` - Comprehensive deployment with configuration
- `scripts/verify-swap-router-referrer.ts` - Post-deployment verification

**Documentation:**
- `TESTING_AND_DEPLOYMENT_GUIDE.md` - Complete testing and deployment guide
- `swaprouter-referrer-router-level-implementation.md` - Detailed implementation docs
- `TEST_COVERAGE_ANALYSIS.md` - Comprehensive test coverage analysis
- `QUICK_REFERENCE.md` - Quick start guide for SwapRouter referrer functionality

### Position Manager Planning Documentation
- `position-manager-referrer-fee-analysis.md` - Technical feasibility analysis (514 lines)
- `position-referrer-implementation-plan.md` - Complete implementation roadmap (784 lines)
- `position-manager-gas-analysis.md` - Gas cost optimization analysis (300 lines)
- `position-referrer-analysis-log.md` - Design evolution and decision log (210 lines)

## Quick Start

For immediate usage of the SwapRouter referrer functionality, see `QUICK_REFERENCE.md` which provides:
- Setup and configuration examples
- Common usage patterns
- Fee collection workflows
- Integration examples