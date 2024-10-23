// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IProcessContract {
    enum State {
        Closed,
        Open,
        Completed
    }

    struct LocalData {
        uint supplies;
    }

    struct GlobalData {
        uint256 basePrice;
        uint256 demandFactor;
        uint256 requestCount;
    }

    struct TaskParticipants {
        address sender;
        address receiver;
    }

    function instancesCount() external view returns (uint);

    function setState(
        uint instanceID,
        string memory _activity,
        uint8 _state
    ) external;

    function setParticipantsByTask(
        uint instanceID,
        string memory taskName,
        address sender,
        address receiver
    ) external;

    function getState(
        uint instanceID,
        string memory _activity
    ) external view returns (State);

    function getParticipantsByTask(
        uint instanceID,
        string memory taskName
    ) external view returns (address sender, address receiver);

    function resetData() external;

    function PurchaseOrder(uint instanceID) external;

    function ConfirmOrder(uint instanceID) external;

    function RestockRequest(uint instanceID) external returns (uint256);

    function ConfirmRestock(uint instanceID) external;

    function CancelOrder(uint instanceID) external;
}