# SwapRouter Referrer Implementation Plan

## Overview
This document outlines the implementation plan for adding referrer functionality to the SwapRouter contract in the Uniswap V3 Periphery repository. The SwapRouter will store a referrer address and pass it to pool contracts during swap operations.

## Current SwapRouter Structure Analysis

### Existing SwapRouter Functions (from Periphery)
- `exactInputSingle()` - Single-hop exact input swap
- `exactOutputSingle()` - Single-hop exact output swap  
- `exactInput()` - Multi-hop exact input swap
- `exactOutput()` - Multi-hop exact output swap
- `multicall()` - Batch multiple operations

### Current Pool Swap Call Pattern
```solidity
IUniswapV3Pool(pool).swap(
    recipient,              // Address to receive output
    zeroForOne,            // Direction: true = token0->token1
    amountSpecified,       // Amount: positive = exact input, negative = exact output
    sqrtPriceLimitX96,     // Price limit as Q64.96
    abi.encode(msg.sender) // Callback data
);
```

## Proposed Referrer Implementation

### 1. Storage Addition

#### Add referrer storage variable
```solidity
/// @notice The referrer address for all swaps processed by this router
/// @dev Only the owner can modify this address
address public referrer;
```

#### Import OpenZeppelin Ownable
```solidity
import "@openzeppelin/contracts/access/Ownable.sol";
```

#### Inherit from Ownable
```solidity
contract SwapRouter is ISwapRouter, PeripheryImmutableState, PeripheryValidation, PeripheryPaymentsWithFee, Multicall, Ownable {
    // ... existing contract code
}
```

### 2. Events

#### Add referrer-related events
```solidity
/// @notice Emitted when the referrer address is changed
/// @param oldReferrer The previous referrer address
/// @param newReferrer The new referrer address
event ReferrerChanged(address indexed oldReferrer, address indexed newReferrer);

// Note: OwnershipTransferred event is already included in OpenZeppelin's Ownable contract
```

### 3. Access Control

#### OpenZeppelin Ownable provides:
- `onlyOwner` modifier (already implemented)
- `owner()` function (already implemented)
- `transferOwnership()` function (already implemented)
- `renounceOwnership()` function (already implemented)
- `OwnershipTransferred` event (already implemented)

#### Initialize ownership in constructor
```solidity
constructor(address _factory, address _WETH9) {
    factory = _factory;
    WETH9 = _WETH9;
    // Note: Ownable constructor automatically sets msg.sender as owner
    // No additional initialization needed
}
```

### 4. Referrer Management Functions

#### setReferrer function
```solidity
/// @notice Sets the referrer address for all swaps
/// @dev Can only be called by the owner
/// @param _referrer The new referrer address (can be address(0) to disable)
function setReferrer(address _referrer) external onlyOwner {
    address oldReferrer = referrer;
    referrer = _referrer;
    emit ReferrerChanged(oldReferrer, _referrer);
}
```

#### Note: Ownership management functions provided by OpenZeppelin Ownable
- `transferOwnership(address newOwner)` - Transfer ownership to new address
- `renounceOwnership()` - Renounce ownership (sets owner to address(0))
- `owner()` - Get current owner address

These functions are already implemented in OpenZeppelin's Ownable contract with proper validation and events.

### 5. Modified Pool Swap Calls

#### Update pool swap calls to include referrer
```solidity
// OLD: Current pool swap call
IUniswapV3Pool(pool).swap(
    recipient,
    zeroForOne,
    amountSpecified,
    sqrtPriceLimitX96,
    abi.encode(msg.sender)
);

// NEW: Pool swap call with referrer
IUniswapV3Pool(pool).swap(
    recipient,
    zeroForOne,
    amountSpecified,
    sqrtPriceLimitX96,
    referrer,              // Pass referrer address
    abi.encode(msg.sender)
);
```

### 6. Modified Swap Functions

#### exactInputSingle with referrer
```solidity
/// @inheritdoc ISwapRouter
function exactInputSingle(ExactInputSingleParams calldata params)
    external
    payable
    override
    checkDeadline(params.deadline)
    returns (uint256 amountOut)
{
    // ... existing validation logic ...
    
    // Calculate pool address
    address pool = PoolAddress.computeAddress(
        factory,
        PoolAddress.getPoolKey(params.tokenIn, params.tokenOut, params.fee)
    );
    
    // Perform swap with referrer
    (int256 amount0, int256 amount1) = IUniswapV3Pool(pool).swap(
        params.recipient,
        zeroForOne,
        params.amountIn.toInt256(),
        params.sqrtPriceLimitX96 == 0
            ? (zeroForOne ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1)
            : params.sqrtPriceLimitX96,
        referrer,  // Pass referrer address
        abi.encode(SwapCallbackData({tokenIn: params.tokenIn, tokenOut: params.tokenOut, fee: params.fee, payer: msg.sender}))
    );
    
    // ... rest of function logic ...
}
```

#### exactOutputSingle with referrer
```solidity
/// @inheritdoc ISwapRouter
function exactOutputSingle(ExactOutputSingleParams calldata params)
    external
    payable
    override
    checkDeadline(params.deadline)
    returns (uint256 amountIn)
{
    // ... existing validation logic ...
    
    // Calculate pool address
    address pool = PoolAddress.computeAddress(
        factory,
        PoolAddress.getPoolKey(params.tokenIn, params.tokenOut, params.fee)
    );
    
    // Perform swap with referrer
    (int256 amount0, int256 amount1) = IUniswapV3Pool(pool).swap(
        params.recipient,
        zeroForOne,
        -params.amountOut.toInt256(),
        params.sqrtPriceLimitX96 == 0
            ? (zeroForOne ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1)
            : params.sqrtPriceLimitX96,
        referrer,  // Pass referrer address
        abi.encode(SwapCallbackData({tokenIn: params.tokenIn, tokenOut: params.tokenOut, fee: params.fee, payer: msg.sender}))
    );
    
    // ... rest of function logic ...
}
```

#### exactInput (multi-hop) with referrer
```solidity
/// @inheritdoc ISwapRouter
function exactInput(ExactInputParams memory params)
    external
    payable
    override
    checkDeadline(params.deadline)
    returns (uint256 amountOut)
{
    // ... existing validation logic ...
    
    while (true) {
        // ... path parsing logic ...
        
        // Perform swap with referrer
        (int256 amount0, int256 amount1) = IUniswapV3Pool(pool).swap(
            recipient,
            zeroForOne,
            amountIn.toInt256(),
            sqrtPriceLimitX96,
            referrer,  // Pass referrer address
            abi.encode(SwapCallbackData({tokenIn: tokenIn, tokenOut: tokenOut, fee: fee, payer: payer}))
        );
        
        // ... rest of loop logic ...
    }
}
```

#### exactOutput (multi-hop) with referrer
```solidity
/// @inheritdoc ISwapRouter
function exactOutput(ExactOutputParams calldata params)
    external
    payable
    override
    checkDeadline(params.deadline)
    returns (uint256 amountIn)
{
    // ... existing validation logic ...
    
    while (true) {
        // ... path parsing logic ...
        
        // Perform swap with referrer
        (int256 amount0, int256 amount1) = IUniswapV3Pool(pool).swap(
            recipient,
            zeroForOne,
            -amountOut.toInt256(),
            sqrtPriceLimitX96,
            referrer,  // Pass referrer address
            abi.encode(SwapCallbackData({tokenIn: tokenIn, tokenOut: tokenOut, fee: fee, payer: payer}))
        );
        
        // ... rest of loop logic ...
    }
}
```

### 7. Interface Updates

#### Add to ISwapRouter interface
```solidity
/// @notice Returns the current referrer address
/// @return The referrer address
function referrer() external view returns (address);

/// @notice Sets the referrer address for all swaps
/// @dev Can only be called by the owner
/// @param _referrer The new referrer address
function setReferrer(address _referrer) external;

// Note: Ownership functions (owner(), transferOwnership(), renounceOwnership()) 
// are already defined in OpenZeppelin's Ownable contract
```

### 8. Upgrade Considerations

#### For existing SwapRouter deployments
Since the SwapRouter contract is typically deployed as an immutable contract, adding referrer functionality would require:

1. **New Deployment**: Deploy a new SwapRouter contract with referrer functionality
2. **Migration Path**: Users would need to approve the new router contract
3. **Factory Integration**: Update factory to point to new router (if applicable)

#### Backwards Compatibility
- New referrer parameter in pool swap calls breaks compatibility with existing pools
- Requires coordinated upgrade of both pool and router contracts
- Consider deploying new router alongside existing one during transition period


### 9. Security Considerations

#### Access Control
- Only owner can change referrer address
- OpenZeppelin's Ownable provides battle-tested ownership management
- Includes proper validation and events for ownership transfer

#### Validation
- Validate referrer address (allow address(0) for no referrer)
- Ensure proper initialization in constructor
- Consider rate limiting or additional validation if needed

#### Gas Optimization
- Referrer address is stored as storage variable (one SLOAD per swap)
- Consider packing with other frequently accessed variables
- Minimal gas overhead for passing referrer to pool

### 10. Testing Strategy

#### Unit Tests
- Test referrer setting and getting
- Test ownership transfer functionality
- Test swap calls with and without referrer
- Test access control (only owner can change referrer)

#### Integration Tests
- Test with actual pool contracts
- Test multi-hop swaps with referrer
- Test referrer fee collection at pool level
- Test gas consumption impact

#### Edge Cases
- Test with referrer = address(0)
- Test ownership renunciation
- Test multiple referrer changes
- Test with various pool configurations

### 11. Documentation Updates

#### NatSpec Documentation
- Document all new functions with proper @notice, @param, @return
- Document events and their purposes
- Document access control requirements

#### Integration Guide
- How to set up referrer for a SwapRouter instance
- How referrer fees are collected at pool level
- How to monitor referrer performance

### 12. Deployment Script Example

```solidity
// Deploy new SwapRouter with referrer functionality
SwapRouter newRouter = new SwapRouter(
    FACTORY_ADDRESS,
    WETH9_ADDRESS
);
// Note: Deployer automatically becomes owner via OpenZeppelin Ownable

// Set initial referrer
newRouter.setReferrer(INITIAL_REFERRER_ADDRESS);

// Transfer ownership to desired address (using OpenZeppelin function)
newRouter.transferOwnership(DESIRED_OWNER_ADDRESS);
```

## Implementation Timeline

### Phase 1: Core Implementation
1. Add storage variables and events
2. Implement access control functions
3. Add referrer management functions

### Phase 2: Swap Function Updates
1. Update exactInputSingle with referrer
2. Update exactOutputSingle with referrer
3. Update multi-hop functions (exactInput, exactOutput)

### Phase 3: Interface and Documentation
1. Update ISwapRouter interface
2. Add comprehensive NatSpec documentation
3. Create deployment and usage guides

### Phase 4: Testing and Validation
1. Write comprehensive unit tests
2. Integration testing with pool contracts
3. Gas optimization analysis
4. Security audit preparation

### Phase 5: Deployment and Migration
1. Deploy new SwapRouter contract
2. Coordinate with pool contract upgrades
3. Migration documentation and guides

## Benefits of This Implementation

1. **Centralized Control**: Router owner controls referrer for all swaps
2. **Simple Integration**: Minimal changes to existing swap logic
3. **Gas Efficient**: Single storage variable, minimal overhead
4. **Flexible**: Can disable referrer by setting to address(0)
5. **Secure**: Proper access control and ownership patterns
6. **Backwards Compatible**: New router can coexist with existing one

## Alternative Approaches

### 1. Per-Transaction Referrer
- Pass referrer as parameter to each swap function
- More flexible but requires changes to all swap calls
- Higher gas cost per transaction

### 2. Referrer Registry
- Separate contract manages referrer mappings
- More complex but allows multiple referrers per router
- Additional external calls increase gas cost

### 3. Frontend-Specified Referrer
- Frontend encodes referrer in callback data
- No router changes needed but less secure
- Referrer not validated or controlled

## Conclusion

This implementation provides a clean, secure, and gas-efficient way to add referrer functionality to the SwapRouter contract. The approach maintains simplicity while providing the necessary control mechanisms for managing referrer addresses. The implementation follows established patterns from the Uniswap ecosystem and provides a solid foundation for referrer-based fee collection.