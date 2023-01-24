const AWS = require('aws-sdk');
const ddb = new AWS.DynamoDB.DocumentClient({ apiVersion: '2012-08-10', region: process.env.AWS_REGION });

const ddbErrorHandler = (err, code, type, connectionId) => {
  console.log(`${connectionId} has failed to ${type}. Error: ${err}`);
  return { statusCode: code, body: `Failed to ${type}:  ${JSON.stringify(err)} ` };
};


exports.handler = async (event) => {

  if (!event.requestContext) {
    return { statusCode: 404, body: 'Request Context not found.' };
  }

  const apig = new AWS.ApiGatewayManagementApi({ apiVersion: '2018-11-29', endpoint: event.requestContext.domainName + '/' + event.requestContext.stage });

  const connectionsTable = process.env.CONNECTIONS_TABLE;
  const roomsTable = process.env.ROOMS_TABLE;
  const connectionId = event.requestContext.connectionId;

  const routeKey = event.requestContext.routeKey;
  console.log(`Event : ${JSON.stringify(event)}`);


  switch (routeKey) {
    case '$connect':
      //On Connection insert connectionId into DynamoDB table 
      const putParams = {
        TableName: connectionsTable,
        Item: { CONNECTION_ID: connectionId }
      };

      try {
        console.log(`Inserting into table ${putParams.TableName} item ${putParams.Item.CONNECTION_ID}`);
        await ddb.put(putParams).promise();
      }
      catch (err) {
        return ddbErrorHandler(err, 500, 'connect', connectionId);
      }

      console.log(`${connectionId} has connected.`);
      return { statusCode: 200, body: 'Connected.' };



    case '$disconnect':
      //On disconnect we need to remove connectionId from DynamoDB table and any games the user is in 
      let getDeleteConnection;
      let getDeleteRoom;

      const deleteConnectionParams = {
        TableName: connectionsTable,
        Key: { CONNECTION_ID: connectionId }
      };

      //Get current connection item so we can get room
      try {
        console.log(`Getting from table ${deleteConnectionParams.TableName} item ${deleteConnectionParams.Key.CONNECTION_ID}`);
        getDeleteConnection = await ddb.get(deleteConnectionParams).promise();
      }
      catch (err) {
        return ddbErrorHandler(err, 500, 'get table', connectionId);
      }
      const connectionRoom = getDeleteConnection.Item.ROOM_NAME;

      //Delete current connection item
      try {
        console.log(`Deleting from table ${deleteConnectionParams.TableName} item ${deleteConnectionParams.Key.CONNECTION_ID}`);
        await ddb.delete(deleteConnectionParams).promise();
      }
      catch (err) {
        return ddbErrorHandler(err, 500, 'delete table', connectionId);
      }

      //If there is no room disconnection is complete
      if (connectionRoom === undefined) {
        console.log(`${connectionId} has disconnected.`);
        return { statusCode: 200, body: 'Disconnected.' };
      }


      const deleteRoomParams = {
        TableName: roomsTable,
        Key: { ROOM_NAME: connectionRoom }
      };

      //Get room we're trying to delete
      try {
        console.log(`Getting from table ${deleteRoomParams.TableName} item ${deleteRoomParams.Key.ROOM_NAME}`);
        getDeleteRoom = await ddb.get(deleteRoomParams).promise();
      }
      catch (err) {
        return ddbErrorHandler(err, 500, 'get table', connectionId);
      }

      //Delete the room item
      try {
        console.log(`Deleting from table ${deleteRoomParams.TableName} item ${deleteRoomParams.Key.ROOM_NAME}`);
        await ddb.delete(deleteRoomParams).promise();
      }
      catch (err) {
        return ddbErrorHandler(err, 500, 'delete table', connectionId);
      }

      //Find the opposing connection to kick them from game
      //Note: Could have computer take over so player doesnt need to be kicked.
      let updateConnectionId;

      if (connectionId === getDeleteRoom.Item.PLAYER_ONE) {
        console.log(`Setting updateConnectionId(Player 1) to  ${connectionId}`);
        updateConnectionId = getDeleteRoom.Item.PLAYER_TWO;
      }
      if (connectionId === getDeleteRoom.Item.PLAYER_TWO) {
        console.log(`Setting updateConnectionId(Player 2) to  ${connectionId}`);
        updateConnectionId = getDeleteRoom.Item.PLAYER_ONE;
      }

      //Remove the remove name from kicked player
      try {
        console.log(`Updating player ${updateConnectionId}`);
        await ddb.update({ TableName: connectionsTable, Key: { CONNECTION_ID: updateConnectionId }, UpdateExpression: `REMOVE ROOM_NAME`, }).promise();
      }
      catch (err) {
        return ddbErrorHandler(err, 500, 'update table', connectionId);
      }
      //Kick player
      try {
        console.log(`Kicking ${updateConnectionId}`);
        await apig.postToConnection({ ConnectionId: updateConnectionId, Data: JSON.stringify({ type: 'kick' }) }).promise();
      }
      catch (err) {
        if (err.statusCode === 410) {
          console.log(`Found stale connection,  ${updateConnectionId}`);
        }
        else {
          console.log(`Error with kicking: ${err}`);
          throw err;
        }
      }

      console.log(`${connectionId} has disconnected.`);
      return { statusCode: 200, body: 'Disconnected.' };





    case 'room':
      //For when a player enters a room.
      //When a player creates a room they are PLAYER_ONE, if then join an existing room they are PLAYER_TWO
      //If it's a computer game set PLAYER_ONE and PLAYER_TWO to same connectionId

      const room = JSON.parse(event.body).room;

      let connectionData;
      let roomData;

      //Determines if user is playing a computer or not (makes room AVAILABLE true or false).
      const multiRoom = JSON.parse(event.body).multiplayer;

      const getRoomParams = { TableName: roomsTable, Key: { ROOM_NAME: room, } };

      //Params to create room and add PLAYER_ONE connectionId
      const addRoomParams = { TableName: roomsTable, Item: { ROOM_NAME: room, PLAYER_ONE: connectionId, AVAILABLE: multiRoom, } };

      //Params to update room and adds PLAYER_TWO connectionId
      const updateRoomsParams = {
        TableName: roomsTable,
        Key: { ROOM_NAME: room, },
        UpdateExpression: `set PLAYER_TWO = :connectionId, AVAILABLE = :bool`,
        ExpressionAttributeValues: {
          ":connectionId": connectionId,
          ":bool": multiRoom,
        },
      };

      //Patams to update connectionId to have room associated with it
      const updateConnectionParams = {
        TableName: connectionsTable,
        Key: { CONNECTION_ID: connectionId, },
        UpdateExpression: `set ROOM_NAME = :room`,
        ExpressionAttributeValues: {
          ":room": room,
        },
      };

      //Gets room data from table
      try {
        console.log(`Getting from table ${getRoomParams.TableName} item ${getRoomParams.Key.ROOM_NAME}`);
        roomData = await ddb.get(getRoomParams).promise();
      }
      catch (err) {
        return ddbErrorHandler(err, 500, 'getting table', connectionId);
      }

      //If there is no room, create room adding PLAYER_ONE as connectionId
      if (roomData.Item === undefined) {
        console.log(`Creating ${room}.`);
        try {
          console.log(`Inserting into table ${addRoomParams.TableName} item ${addRoomParams.Item.ROOM_NAME}`);
          await ddb.put(addRoomParams).promise();
        }
        catch (err) {
          return ddbErrorHandler(err, 500, 'inserting into table', connectionId);
        }
      }
      //If the room exists and PLAYER_TWO is undefined update item to include PLAYER_TWO connectionId
      else if (roomData.Item.PLAYER_TWO === undefined) {
        try {
          console.log(`Updating table ${updateRoomsParams.TableName} item ${room}`);
          await ddb.update(updateRoomsParams).promise();
        }
        catch (err) {
          return ddbErrorHandler(err, 500, 'updating table', connectionId);
        }

      }
      //If room is full, send access denied to connectionId
      else {
        console.log(`${room} access denied.`);
        try {
          await apig.postToConnection({ ConnectionId: connectionId, Data: JSON.stringify({ type: 'room', allowed: false }) }).promise();
        }
        catch (err) {
          console.log(`Error sending ${room} access denied: ${err}`);
          throw err;
        }
        return { statusCode: 200, body: 'Room access denied' };
      }

      //Sends access approve to connectionId
      console.log(`Joining ${room}.`);
      try {
        await apig.postToConnection({ ConnectionId: connectionId, Data: JSON.stringify({ type: 'room', allowed: true }) }).promise();
      }
      catch (err) {
        console.log(`Error sending ${room} access approved: ${err}`);
        throw err;
      }

      //Update connectionId table to have room associated
      try {
        console.log(`Updating table ${updateConnectionParams.TableName} item ${connectionId}`);
        await ddb.update(updateConnectionParams).promise();
      }
      catch (err) {
        return ddbErrorHandler(err, 500, 'updating table', connectionId);
      }



      console.log(`Broadcasting Available Rooms`);
      //Get all connections
      try {
        console.log(`Scanning table ${connectionsTable} expression CONNECTION_ID`);
        connectionData = await ddb.scan({ TableName: connectionsTable, ProjectionExpression: 'CONNECTION_ID' }).promise();
        console.log("Found connection data " + JSON.stringify(connectionData));
      }
      catch (err) {
        return ddbErrorHandler(err.stack, 500, 'scanning connections table', connectionId);
      }

      //Get all available rooms
      let rooms;
      try {
        console.log(`Scanning table ${roomsTable} expression ROOM_NAME`);
        rooms = await ddb.scan({
          TableName: roomsTable,
          Select: 'SPECIFIC_ATTRIBUTES',
          ProjectionExpression: 'ROOM_NAME',
          FilterExpression: "AVAILABLE = :bool",
          ExpressionAttributeValues: {
            ":bool": true
          },
        }).promise();
      }
      catch (err) {
        return ddbErrorHandler(err.stack, 500, 'scanning rooms table', connectionId);
      }

      //Get all available rooms as an array
      const roomsArray = rooms.Items.map((room) => {
        return room.ROOM_NAME;
      });

      //Broadcasts all available rooms to connected
      const broadcastRooms = connectionData.Items.map(async ({ CONNECTION_ID }) => {
        let broadcastConnectionId = CONNECTION_ID;

        try {
          console.log(`Sending rooms to  ${broadcastConnectionId}.`);
          await apig.postToConnection({ ConnectionId: broadcastConnectionId, Data: JSON.stringify({ type: 'rooms', rooms: roomsArray }) }).promise();
        }
        catch (err) {
          if (err.statusCode === 410) {
            console.log(`Found stale connection, deleting ${broadcastConnectionId}.`);
            await ddb.delete({ TableName: connectionsTable, Key: { broadcastConnectionId } }).promise();
          }
          else {
            console.log(`Error with sending rooms: ${err}`);
            throw err;
          }
        }
      });

      try {
        await Promise.all(broadcastRooms);
      }
      catch (err) {
        console.log('Error Broadcasting');
        return { statusCode: 500, body: err.stack };
      }
      return { statusCode: 200, body: 'Room Query Successful' };






    case 'setBoard':
      //Sets initial board states for players

      let boardRoomName;
      let setBoardRoom;
      let oppConnectionId;
      let ready = false;
      let setBoardUpdateExpression;

      //Determines if a computer player sent the setBoard request.
      const computer = JSON.parse(event.body).computer;


      //Get connection room name.
      try {
        console.log(`Getting from table ${connectionsTable} item ${connectionId}`);
        const setBoardRoom = await ddb.get({
          TableName: connectionsTable,
          Key: { CONNECTION_ID: connectionId, }
        }).promise();

        boardRoomName = setBoardRoom.Item.ROOM_NAME;

      }
      catch (err) {
        return ddbErrorHandler(err.stack, 500, 'getting connections table', connectionId);
      }

      //Get connection room item
      try {
        console.log(`Getting from table ${roomsTable} item ${boardRoomName}`);
        setBoardRoom = await ddb.get({
          TableName: roomsTable,
          Key: { ROOM_NAME: boardRoomName, }
        }).promise();
      }
      catch (err) {
        return ddbErrorHandler(err.stack, 500, 'getting rooms table', connectionId);
      }

      //Checking which player connectedId is and if other player is ready
      if (setBoardRoom.Item.PLAYER_ONE === connectionId) {
        if (setBoardRoom.Item.PLAYER_TWO_READY) {
          ready = true;
        }
        console.log('ADD PLAYER ONE');
        setBoardUpdateExpression = `set PLAYER_ONE_BOARD = :1board, PLAYER_ONE_SHIPS = :ships, PLAYER_ONE_OPPONENT = :2board, PLAYER_ONE_READY = :ready, PLAYER_ONE_REMAINING = :ships`;
        oppConnectionId = setBoardRoom.Item.PLAYER_TWO;


      }
      //If a computer game, PLAYER_TWO isn't set
      if (setBoardRoom.Item.PLAYER_TWO === connectionId) {
        if (setBoardRoom.Item.PLAYER_ONE_READY) {
          ready = true;
        }
        console.log('ADD PLAYER TWO');
        setBoardUpdateExpression = `set PLAYER_TWO_BOARD = :1board, PLAYER_TWO_SHIPS = :ships, PLAYER_TWO_OPPONENT = :2board, PLAYER_TWO_READY = :ready, PLAYER_TWO_REMAINING = :ships`;
        oppConnectionId = setBoardRoom.Item.PLAYER_ONE;
      }

      if (computer) {
        setBoardUpdateExpression = `set COMPUTER =:computer, PLAYER_TWO_BOARD = :1board, PLAYER_TWO_SHIPS = :ships, PLAYER_TWO_OPPONENT = :2board, PLAYER_TWO_READY = :ready, PLAYER_TWO_REMAINING = :ships`;
        oppConnectionId = null;
        ready = true;
      }

      //Start game if ready
      if (ready) {
        //Sending start to connectionId and oppConnectionId
        try {
          console.log(`Sending start to ${connectionId}`);
          await apig.postToConnection({ ConnectionId: connectionId, Data: JSON.stringify({ type: 'start' }) }).promise();
          //If it's a computer game, player starts first
          if (computer) {
            await apig.postToConnection({ ConnectionId: connectionId, Data: JSON.stringify({ type: 'turn' }) }).promise();
          }
        }
        catch (err) {
          console.log(`Error sending start: ${err}`);
          throw err;
        }

        try {
          //If computer game, oppConnectionId is null
          if (!computer) {
            console.log(`Sending start to ${oppConnectionId}`);
            await apig.postToConnection({ ConnectionId: oppConnectionId, Data: JSON.stringify({ type: 'start' }) }).promise();
            await apig.postToConnection({ ConnectionId: oppConnectionId, Data: JSON.stringify({ type: 'turn' }) }).promise();
          }
        }
        catch (err) {
          console.log(`Error sending start and turn: ${err}`);
          throw err;
        }
      }

      //Update game boards
      const setBoardData = JSON.parse(event.body);

      const setBoardPlayerBoard = JSON.parse(setBoardData.player).board;
      const setBoardPlayerShips = JSON.parse(setBoardData.player).shipLocations;

      const setBoardOpponentBoard = JSON.parse(setBoardData.opponent);

      try {
        console.log(`Updating table ${roomsTable} expression ${setBoardUpdateExpression}`);
        await ddb.update({
          TableName: roomsTable,
          Key: {
            ROOM_NAME: boardRoomName,

          },
          UpdateExpression: setBoardUpdateExpression,
          ExpressionAttributeValues: {
            ":1board": setBoardPlayerBoard,
            ":ships": setBoardPlayerShips,
            ":2board": setBoardOpponentBoard,
            ":ready": true,
            ":computer": computer,

          }

        }).promise();

      }
      catch (err) {
        return ddbErrorHandler(err.stack, 500, 'updating rooms table', connectionId);
      }
      return { statusCode: 200, body: 'Set Board Successful' };






    case 'fire':
      //Handles fire coords and updates game boards.

      let fireRoomName;
      let fireRoom;

      let coord = JSON.parse(event.body).where;
      //Gets connectionId item
      try {
        console.log(`Getting table ${connectionsTable} expression ${connectionId}`);
        const setFireRoom = await ddb.get({
          TableName: connectionsTable,
          Key: { CONNECTION_ID: connectionId }
        }).promise();

        //Gets room associated with connectionId
        fireRoomName = setFireRoom.Item.ROOM_NAME;
      }
      catch (err) {
        return ddbErrorHandler(err.stack, 500, 'getting connections table', connectionId);
      }

      //Gets game room data
      try {
        console.log(`Getting table ${roomsTable} expression ${fireRoomName}`);
        const getFireRoom = await ddb.get({
          TableName: roomsTable,
          Key: { ROOM_NAME: fireRoomName }
        }).promise();
        fireRoom = getFireRoom.Item;
      }
      catch (err) {
        return ddbErrorHandler(err.stack, 500, 'getting rooms table', connectionId);
      }

      //Determines if a computer sent the shot.
      const fireComputer = JSON.parse(event.body).computer;

      //Determines if this game is a computer game.
      let computerGame = false;

      if (fireRoom.COMPUTER) {
        computerGame = true;
      }

      let square; //Coord status (empty, hit, miss...)

      let playerBoard; //Players board 
      let oppBoard; //Opp board

      let playerOppBoard; //Board player sees for opponent
      let oppPlayerBoard; //Board opponent sees for player

      let playerShipsRemaining; //Players ships remaining
      let oppShipsRemaining; //Opponents ships remaining
      
      let oppShips;

      let playerOppConnectionId; //Opponents connectionId

      let fireUpdateExpr; //Expression to update the game



      if (fireRoom.PLAYER_ONE === connectionId) {

        if (computerGame) {
          playerOppConnectionId = fireRoom.PLAYER_ONE;
        }
        else {
          playerOppConnectionId = fireRoom.PLAYER_TWO;

        }

        square = fireRoom.PLAYER_TWO_BOARD[coord];

        playerBoard = fireRoom.PLAYER_ONE_BOARD;
        oppBoard = fireRoom.PLAYER_TWO_BOARD;

        playerOppBoard = fireRoom.PLAYER_ONE_OPPONENT;
        oppPlayerBoard = fireRoom.PLAYER_TWO_OPPONENT;


        playerShipsRemaining = fireRoom.PLAYER_ONE_REMAINING;
        oppShipsRemaining = fireRoom.PLAYER_TWO_REMAINING;
        
        oppShips = fireRoom.PLAYER_TWO_SHIPS;


        fireUpdateExpr = 'set PLAYER_ONE_BOARD = :b1, PLAYER_TWO_BOARD = :b2, PLAYER_ONE_OPPONENT = :o1, PLAYER_TWO_OPPONENT = :o2, PLAYER_ONE_REMAINING = :r1, PLAYER_TWO_REMAINING = :r2';
      }

      if (fireRoom.PLAYER_TWO === connectionId || fireComputer === true) {
        playerOppConnectionId = fireRoom.PLAYER_ONE;

        square = fireRoom.PLAYER_ONE_BOARD[coord];

        playerBoard = fireRoom.PLAYER_TWO_BOARD;
        oppBoard = fireRoom.PLAYER_ONE_BOARD;

        playerOppBoard = fireRoom.PLAYER_TWO_OPPONENT;
        oppPlayerBoard = fireRoom.PLAYER_ONE_OPPONENT;


        playerShipsRemaining = fireRoom.PLAYER_TWO_REMAINING;
        oppShipsRemaining = fireRoom.PLAYER_ONE_REMAINING;
        
        oppShips = fireRoom.PLAYER_ONE_SHIPS;

        fireUpdateExpr = 'set PLAYER_ONE_BOARD = :b2, PLAYER_TWO_BOARD = :b1, PLAYER_ONE_OPPONENT = :o2, PLAYER_TWO_OPPONENT = :o1, PLAYER_ONE_REMAINING = :r2, PLAYER_TWO_REMAINING = :r1';

      }


      if (square === 'empty') {
        oppBoard[coord] = 'miss';
        playerOppBoard[coord] = 'miss';

        //Multiplayer Game
        if (!computerGame) {
          try {
            await apig.postToConnection({ ConnectionId: connectionId, Data: JSON.stringify({ type: 'turn' }) }).promise();
          }
          catch (err) {
            console.log(`Error sending turn: :${err}`);
          }
          try {
            await apig.postToConnection({ ConnectionId: playerOppConnectionId, Data: JSON.stringify({ type: 'turn' }) }).promise();
          }
          catch (err) {
            console.log(`Error sending turn: :${err}`);
          }
          //Computer Game
        }
        else {

          if (fireComputer) {
            try {
              await apig.postToConnection({ ConnectionId: connectionId, Data: JSON.stringify({ type: 'turn' }) }).promise();
            }
            catch (err) {
              console.log(`Error sending turn: :${err}`);
            }

          }
          else {
            try {
              await apig.postToConnection({ ConnectionId: connectionId, Data: JSON.stringify({ type: 'computerTurn', board: oppPlayerBoard }) }).promise();

            }
            catch (err) {
              console.log(`Error sending computer turn: :${err}`);
            }
          }
        }
      }



      if (square === 'ship') {
        oppBoard[coord] = 'hit';
        playerOppBoard[coord] = 'hit';

        //For each remaining ship
        oppShipsRemaining.forEach((ship, i) => {
          //Determine if the hit coord is in the ships location
          const index = ship.location.indexOf(coord);

          //If it finds the coord, remove it
          if (index !== -1) {
            ship.location.splice(index, 1);
          }
          //If the ships location is empty
          if (ship.location.length === 0) {

            const sunk = oppShips.find((sunk) => sunk.name === ship.name);
            console.log(`SUNK: ${sunk}`);
            //Changes all hit squares to sunk
            sunk.location.forEach((square) => {
              oppBoard[square] = 'sunk';
              playerOppBoard[square] = 'sunk';
            });
            //Removes ship
            oppShipsRemaining.splice(i, 1);
          }
        });
        if (fireComputer) {
          //If a computer send the shot, tell it to take another turn.
          try {
            await apig.postToConnection({ ConnectionId: connectionId, Data: JSON.stringify({ type: 'computerTurnAgain', board: playerOppBoard }) }).promise();
          }
          catch (err) {
            console.log(`Error sending computer turn again: :${err}`);
          }
        }
      }


      try {
        await ddb.update({
          TableName: roomsTable,
          Key: { ROOM_NAME: fireRoomName },
          UpdateExpression: fireUpdateExpr,
          ExpressionAttributeValues: {
            ':b1': playerBoard,
            ':b2': oppBoard,
            ':r1': playerShipsRemaining,
            ':r2': oppShipsRemaining,
            ':o1': playerOppBoard,
            ':o2': oppPlayerBoard
          }
        }).promise();
      }
      catch (e) {
        console.log(e);
      }

      //Win Lose conditions, doesn't send PLAYER_TWO if computer game
      if (fireRoom.PLAYER_TWO_BOARD.indexOf('ship') === -1) {
        try {
          await apig.postToConnection({ ConnectionId: fireRoom.PLAYER_ONE, Data: JSON.stringify({ type: 'win' }) }).promise();
        }
        catch (err) {
          console.log(`Error sending win to ${fireRoom.PLAYER_ONE}:${err}`);
        }

        if (!computerGame) {
          try {
            await apig.postToConnection({ ConnectionId: fireRoom.PLAYER_TWO, Data: JSON.stringify({ type: 'lose' }) }).promise();
          }
          catch (err) {
            console.log(`Error sending lose to ${fireRoom.PLAYER_TWO}:${err}`);
          }

        }

      }
      if (fireRoom.PLAYER_ONE_BOARD.indexOf('ship') === -1) {
        if (!computerGame) {
          try {
            await apig.postToConnection({ ConnectionId: fireRoom.PLAYER_TWO, Data: JSON.stringify({ type: 'win' }) }).promise();
          }
          catch (err) {
            console.log(`Error sending win to ${fireRoom.PLAYER_TWO}:${err}`);
          }
        }
        try {
          await apig.postToConnection({ ConnectionId: fireRoom.PLAYER_ONE, Data: JSON.stringify({ type: 'lose' }) }).promise();
        }
        catch (err) {
          console.log(`Error sending lose to ${fireRoom.PLAYER_ONE}:${err}`);
        }

      }


      //Sends new board states to players
      if (!computerGame) {
        try {
          await apig.postToConnection({ ConnectionId: fireRoom.PLAYER_TWO, Data: JSON.stringify({ type: 'setYou', player: { board: fireRoom.PLAYER_TWO_BOARD, shipLocations: fireRoom.PLAYER_TWO_SHIPS } }) }).promise();

        }
        catch (err) {
          console.log(`Error sending setYou to ${fireRoom.PLAYER_TWO}:${err}`);
        }
        try {
          await apig.postToConnection({ ConnectionId: fireRoom.PLAYER_TWO, Data: JSON.stringify({ type: 'setOpponent', player: { board: fireRoom.PLAYER_TWO_OPPONENT, shipLocations: fireRoom.PLAYER_ONE_SHIPS } }) }).promise();

        }
        catch (err) { console.log(`Error sending setOpponent to ${fireRoom.PLAYER_TWO}:${err}`); }

      }

      try {
        await apig.postToConnection({ ConnectionId: fireRoom.PLAYER_ONE, Data: JSON.stringify({ type: 'setYou', player: { board: fireRoom.PLAYER_ONE_BOARD, shipLocations: fireRoom.PLAYER_ONE_SHIPS } }) }).promise();

      }
      catch (err) {
        console.log(`Error sending setYou to ${fireRoom.PLAYER_ONE}:${err}`);
      }
      try {
        await apig.postToConnection({ ConnectionId: fireRoom.PLAYER_ONE, Data: JSON.stringify({ type: 'setOpponent', player: { board: fireRoom.PLAYER_ONE_OPPONENT, shipLocations: fireRoom.PLAYER_TWO_SHIPS } }) }).promise();

      }
      catch (err) { console.log(`Error sending setOpponent to ${fireRoom.PLAYER_ONE}:${err}`); }

      return { statusCode: 200, body: 'Set Board Successful' };



    case 'getRoom':
      //Gets all available rooms for connectionId
      let getRoomsArray;
      try {
        const roomsC = await ddb.scan({
          TableName: roomsTable,
          Select: 'SPECIFIC_ATTRIBUTES',
          ProjectionExpression: 'ROOM_NAME',
          FilterExpression: "AVAILABLE = :val1",
          ExpressionAttributeValues: {
            ":val1": true
          },
        }).promise();

        getRoomsArray = roomsC.Items.map((room) => {
          return room.ROOM_NAME;
        });
        await apig.postToConnection({ ConnectionId: connectionId, Data: JSON.stringify({ type: 'rooms', rooms: getRoomsArray }) }).promise();
      }
      catch (e) {
        console.log(`ERROR: ${e}`);
      }
      return { statusCode: 200, body: 'Set Rooms Successful' };


    default:
    console.log('Deafult');
    return { statusCode: 200, body: 'Default use case' };

  }


};
