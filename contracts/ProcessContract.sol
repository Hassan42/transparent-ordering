// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract ProcessContract {
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
        uint256 basePrice; // Base price in wei
        uint256 demandFactor; // Price increase factor (percentage, e.g., 10 for 10%)
        uint256 requestCount; // Number of requests made
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

    uint256 constant SCALING_FACTOR = 100; 

    // Constructor
    constructor() {
        globalData.basePrice = 1 * SCALING_FACTOR;
        globalData.demandFactor = 10 * SCALING_FACTOR;
    }

    // Instance Management
    function newInstance(address[] memory participants) public {
        require(
            participants.length == 3,
            "Exactly three participants required"
        );

        address customer = participants[0];
        address retailer = participants[1];
        address manufacturer = participants[2];

        require(
            customer != address(0) &&
                retailer != address(0) &&
                manufacturer != address(0),
            "Invalid participant address"
        );

        instancesCount++;

        instances[instancesCount].participants[Role.Customer] = customer;
        instances[instancesCount].participants[Role.Retailer] = retailer;
        instances[instancesCount].participants[
            Role.Manufacturer
        ] = manufacturer;

        instances[instancesCount].taskParticipants[
            "PurchaseOrder"
        ] = TaskParticipants(customer, retailer);
        instances[instancesCount].taskParticipants[
            "ConfirmOrder"
        ] = TaskParticipants(retailer, customer);
        instances[instancesCount].taskParticipants[
            "RestockRequest"
        ] = TaskParticipants(retailer, manufacturer);
        instances[instancesCount].taskParticipants[
            "ConfirmRestock"
        ] = TaskParticipants(manufacturer, retailer);
        instances[instancesCount].taskParticipants[
            "CancelOrder"
        ] = TaskParticipants(customer, retailer);

        instances[instancesCount].state["PurchaseOrder"] = State.Open;
        globalData.supplies[retailer] = 1;

        emit InstanceCreated(instancesCount);
    }

    function setParticipantsByTask(
        uint instanceID,
        string memory taskName,
        address sender,
        address receiver
    ) public {
        instances[instanceID].taskParticipants[taskName] = TaskParticipants(
            sender,
            receiver
        );
    }

    function setState(
        uint instanceID,
        string memory _activity,
        uint8 _state
    ) public {
        require(_state <= 2, "Invalid state");
        instances[instanceID].state[_activity] = State(_state);
    }

    // Task Management Functions
    function PurchaseOrder(uint instanceID) public {
        address retailer = instances[instanceID].participants[Role.Retailer];

        if (globalData.supplies[retailer] > 0) {
            globalData.supplies[retailer] -= 1;
            instances[instanceID].state["ConfirmOrder"] = State.Open;
        } else {
            instances[instanceID].state["RestockRequest"] = State.Open;
        }

        instances[instanceID].state["PurchaseOrder"] = State.Completed;
    }

    function ConfirmOrder(uint instanceID) public {
        instances[instanceID].state["ConfirmOrder"] = State.Completed;
    }

    function RestockRequest(uint instanceID) public {
        globalData.requestCount++;
        uint256 newPrice = calculatePrice();

        instances[instanceID].state["ConfirmRestock"] = State.Open;
        instances[instanceID].state["CancelOrder"] = State.Open;
        instances[instanceID].state["RestockRequest"] = State.Completed;

        emit NewPrice(instanceID, newPrice, globalData.requestCount);
    }

    function ConfirmRestock(uint instanceID) public {
        // address retailer = instances[instanceID].participants[Role.Retailer];
        // globalData.supplies[retailer] = 1;
        instances[instanceID].state["CancelOrder"] = State.Closed;
        instances[instanceID].state["ConfirmRestock"] = State.Completed;
    }

    function CancelOrder(uint instanceID) public {
        instances[instanceID].state["ConfirmRestock"] = State.Closed;
        instances[instanceID].state["CancelOrder"] = State.Completed;
    }

    function executeTask(
        uint instanceID,
        string memory taskName
    ) public isAccessible(instanceID, taskName) {

        // Determine which task to execute
        if (compareStrings(taskName, "PurchaseOrder")) {
            PurchaseOrder(instanceID);
        } else if (compareStrings(taskName, "ConfirmOrder")) {
            ConfirmOrder(instanceID);
        } else if (compareStrings(taskName, "RestockRequest")) {
            RestockRequest(instanceID);
        } else if (compareStrings(taskName, "ConfirmRestock")) {
            ConfirmRestock(instanceID);
        } else if (compareStrings(taskName, "CancelOrder")) {
            CancelOrder(instanceID);
        } else {
            revert("Unknown task name");
        }
        emit TaskCompleted(instanceID, taskName);
    }

    // Global Data Reset
    function resetData() public {
        for (uint i = 1; i <= instancesCount; i++) {
            address retailer = instances[i].participants[Role.Retailer];
            instances[i].state["PurchaseOrder"] = State.Open;
            globalData.supplies[retailer] = 1;
        }
        globalData.requestCount = 0;
    }

    function resetInstanceState(uint instancdId) public {
        address retailer = instances[instancdId].participants[Role.Retailer];
        instances[instancdId].state["PurchaseOrder"] = State.Open;
        globalData.supplies[retailer] = 1;
    }

    // Helper Functions
    function compareStrings(
        string memory a,
        string memory b
    ) internal pure returns (bool) {
        return keccak256(abi.encodePacked(a)) == keccak256(abi.encodePacked(b));
    }

    function calculatePrice() internal view returns (uint256) {
        uint256 priceIncrease = 0;
        if (globalData.requestCount > 1) {
            priceIncrease = (globalData.basePrice *
                globalData.demandFactor *
                globalData.requestCount) / (100 * SCALING_FACTOR); // Scale down by the scaling factor
        }
        return globalData.basePrice + priceIncrease; // Return total price
    }

    // Getter Functions
    function getTaskState(
        uint instanceID,
        string memory _activity
    ) public view returns (State) {
        return instances[instanceID].state[_activity];
    }

    function getProcessState(
        uint instanceID
    ) public view returns (string[] memory) {
        // Define task names
        string[5] memory tasks = [
            "PurchaseOrder",
            "ConfirmOrder",
            "RestockRequest",
            "ConfirmRestock",
            "CancelOrder"
        ];

        // Count open tasks to define array size
        uint openTaskCount = 0;
        for (uint i = 0; i < tasks.length; i++) {
            if (instances[instanceID].state[tasks[i]] == State.Open) {
                openTaskCount++;
            }
        }

        // Create a dynamic array to store open tasks
        string[] memory openTasks = new string[](openTaskCount);
        uint index = 0;

        // Add open tasks to the array
        for (uint i = 0; i < tasks.length; i++) {
            if (instances[instanceID].state[tasks[i]] == State.Open) {
                openTasks[index] = tasks[i];
                index++;
            }
        }

        return openTasks;
    }

    function getParticipantsByTask(
        uint instanceID,
        string memory taskName
    ) public view returns (address sender, address receiver) {
        TaskParticipants memory participants = instances[instanceID]
            .taskParticipants[taskName];
        return (participants.sender, participants.receiver);
    }
}
