# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build Commands

- `npm run compile` - Compile all Solidity contracts using Hardhat
- `npm run test` - Run the full test suite

## Testing

Tests are located in the `test/` directory and use Hardhat with Waffle and Chai. Test files are organized by contract:
- Individual contract tests: `SwapRouter.spec.ts`, `NonfungiblePositionManager.spec.ts`, etc.
- Gas analysis: `SwapRouter.gas.spec.ts`
- Library tests: `Path.spec.ts`, `PoolAddress.spec.ts`, etc.

Run a single test file:
```bash
npx hardhat test test/SwapRouter.spec.ts
```

## Architecture Overview

This is the **Uniswap V3 Periphery** repository containing smart contracts that interact with the Uniswap V3 Core protocol. The periphery contracts provide user-friendly interfaces and additional functionality on top of the core pool contracts.

### Key Contracts

**Core Router Contracts:**
- `SwapRouter.sol` - Main entry point for token swaps (exact input/output, single/multi-hop)
- `NonfungiblePositionManager.sol` - Manages liquidity positions as ERC721 NFTs

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

### Library Architecture

Key libraries in `contracts/libraries/`:
- `Path.sol` - Encodes/decodes swap paths for multi-hop swaps
- `PoolAddress.sol` - Computes pool addresses deterministically
- `CallbackValidation.sol` - Validates callbacks from core pools
- `LiquidityAmounts.sol` - Calculates token amounts for liquidity operations
- `PositionKey.sol` - Generates keys for liquidity positions

## Development Notes

**Solidity Version:** 0.7.6 with ABIEncoderV2
**Framework:** Hardhat with TypeScript

**Compiler Settings:**
- Most contracts: 1,000,000 optimizer runs (for deployment efficiency)
- `NonfungiblePositionManager`: 2,000 runs (size optimization)
- NFT descriptor contracts: 1,000 runs (size optimization)

**Key Dependencies:**
- `@uniswap/v3-core` - Core pool contracts and libraries
- `@openzeppelin/contracts` v3.4.2 - For ERC20, ERC721, and utility contracts

**Testing Framework:**
- Hardhat + Ethers.js + Waffle + Chai
- Snapshot testing for gas costs and complex outputs
- Mock contracts in `contracts/test/` for testing scenarios