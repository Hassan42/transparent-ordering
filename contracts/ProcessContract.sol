// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract ProcessContract {
    // Enums for defining possible states and roles
    enum State { Closed, Open, Completed }
    enum Role { Customer, Retailer, Manufacturer }

    // Events
    event InstanceCreated(uint instanceID);

    // Modifiers
    modifier isAccessible(uint instanceID, string memory _activity) {
        require(
            instances[instanceID].state[_activity] == State.Open,
            "Activity is not open"
        );
        require(
            instances[instanceID].taskParticipants[_activity].sender ==
                msg.sender,
            "Caller does not have the required role"
        );
        _;
    }

    // Structs
    struct GlobalData {
        mapping(address => uint) supplies; // Supplies per retailer
        uint256 basePrice;      // Base price in wei
        uint256 demandFactor;   // Price increase factor (percentage, e.g., 10 for 10%)
        uint256 requestCount;   // Number of requests made
    }
    
    struct TaskParticipants {
        address sender;
        address receiver;
    }

    struct Instance {
        mapping(string => State) state;
        mapping(Role => address) participants;
        mapping(string => TaskParticipants) taskParticipants;
    }

    // State Variables
    uint public instancesCount;
    GlobalData public globalData;
    mapping(uint => Instance) private instances;

    // Constructor
    constructor() {}

    // Instance Management
    function newInstance(address[] memory participants) public {
        require(participants.length == 3, "Exactly three participants required");

        uint instanceID = instancesCount++;
        address customer = participants[0];
        address retailer = participants[1];
        address manufacturer = participants[2];

        require(customer != address(0) && retailer != address(0) && manufacturer != address(0), "Invalid participant address");

        instances[instanceID].participants[Role.Customer] = customer;
        instances[instanceID].participants[Role.Retailer] = retailer;
        instances[instanceID].participants[Role.Manufacturer] = manufacturer;

        instances[instanceID].taskParticipants["PurchaseOrder"] = TaskParticipants(customer, retailer);
        instances[instanceID].taskParticipants["ConfirmOrder"] = TaskParticipants(retailer, customer);
        instances[instanceID].taskParticipants["RestockRequest"] = TaskParticipants(retailer, manufacturer);
        instances[instanceID].taskParticipants["ConfirmRestock"] = TaskParticipants(manufacturer, retailer);
        instances[instanceID].taskParticipants["CancelOrder"] = TaskParticipants(customer, retailer);

        instances[instanceID].state["PurchaseOrder"] = State.Open;

        emit InstanceCreated(instanceID);
    }

    function setParticipantsByTask(uint instanceID, string memory taskName, address sender, address receiver) public {
        instances[instanceID].taskParticipants[taskName] = TaskParticipants(sender, receiver);
    }

    function setState(uint instanceID, string memory _activity, uint8 _state) public {
        require(_state <= 2, "Invalid state");
        instances[instanceID].state[_activity] = State(_state);
    }

    // Task Management Functions
    function PurchaseOrder(uint instanceID) public isAccessible(instanceID, "PurchaseOrder") {
        address retailer = instances[instanceID].participants[Role.Retailer];

        if (globalData.supplies[retailer] > 0) {
            instances[instanceID].state["ConfirmOrder"] = State.Open;
        } else {
            instances[instanceID].state["RestockRequest"] = State.Open;
        }

        instances[instanceID].state["PurchaseOrder"] = State.Completed;
    }

    function ConfirmOrder(uint instanceID) public isAccessible(instanceID, "ConfirmOrder") {
        instances[instanceID].state["ConfirmOrder"] = State.Completed;
    }

    function RestockRequest(uint instanceID) public isAccessible(instanceID, "RestockRequest") returns (uint256) {
        globalData.requestCount++;
        uint256 newPrice = calculatePrice();

        instances[instanceID].state["ConfirmRestock"] = State.Open;
        instances[instanceID].state["CancelOrder"] = State.Open;
        instances[instanceID].state["RestockRequest"] = State.Completed;

        return newPrice;
    }

    function ConfirmRestock(uint instanceID) public isAccessible(instanceID, "ConfirmRestock") {
        address retailer = instances[instanceID].participants[Role.Retailer];
        globalData.supplies[retailer] = 1;

        instances[instanceID].state["ConfirmOrder"] = State.Open;
        instances[instanceID].state["ConfirmRestock"] = State.Completed;
    }

    function CancelOrder(uint instanceID) public isAccessible(instanceID, "CancelOrder") {
        instances[instanceID].state["CancelOrder"] = State.Completed;
    }

    // Global Data Reset
    function resetData() public {
        for (uint i = 0; i < instancesCount; i++) {
            address retailer = instances[i].participants[Role.Retailer];
            globalData.supplies[retailer] = 1;
        }
        globalData.requestCount = 0;
    }

    // Helper Functions
    function compareStrings(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(abi.encodePacked(a)) == keccak256(abi.encodePacked(b));
    }

    function calculatePrice() internal view returns (uint256) {
        uint256 priceIncrease = globalData.requestCount > 1
            ? (globalData.basePrice * globalData.demandFactor * globalData.requestCount) / 100
            : 0;

        return globalData.basePrice + priceIncrease;
    }

    // Getter Functions
    function getState(uint instanceID, string memory _activity) public view returns (State) {
        return instances[instanceID].state[_activity];
    }

    function getParticipantsByTask(uint instanceID, string memory taskName) public view returns (address sender, address receiver) {
        TaskParticipants memory participants = instances[instanceID].taskParticipants[taskName];
        return (participants.sender, participants.receiver);
    }
}