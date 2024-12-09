// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IProcessContract {
    // Enums for defining possible states and roles
    enum State {
        Closed,
        Open,
        Completed
    }
    enum Role {
        Customer,
        Retailer,
        Manufacturer
    }

    // Events
    event InstanceCreated(uint instanceID);
    event NewPrice(uint instanceId, uint newPrice, uint requestCount);
    event TaskCompleted(uint instanceID, string taskName);

    // Instance Management
    function newInstance(address[] memory participants) external;

    function setParticipantsByTask(
        uint instanceID,
        string memory taskName,
        address sender,
        address receiver
    ) external;

    function setState(
        uint instanceID,
        string memory _activity,
        uint8 _state
    ) external;

    // Task Management Functions
    function PurchaseOrder(uint instanceID) external;

    function ConfirmOrder(uint instanceID) external;

    function RestockRequest(uint instanceID) external;

    function ConfirmRestock(uint instanceID) external;

    function CancelOrder(uint instanceID) external;

    function executeTask(
        uint instanceID,
        string memory taskName
    ) external;

    // Global Data Reset
    function resetData() external;

    function resetInstanceState(uint instanceID) external;

    // Helper Functions
    function compareStrings(
        string memory a,
        string memory b
    ) external pure returns (bool);

    function calculatePrice() external view returns (uint256);

    function setOrderingContractAddress(address _orderingContractAddress) external;

    // Getter Functions
    function getTaskState(
        uint instanceID,
        string memory _activity
    ) external view returns (State);

    function getProcessState(
        uint instanceID
    ) external view returns (string[] memory);

    function getParticipantsByTask(
        uint instanceID,
        string memory taskName
    ) external view returns (address sender, address receiver);

    function getParticipants(
        uint instanceID
    ) external view returns (address[] memory);
}