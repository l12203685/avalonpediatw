import { Room, Player } from '@avalon/shared';

export class RoomManager {
  private rooms: Map<string, Room> = new Map();

  public createRoom(roomId: string, hostName: string, hostId: string): Room {
    const room: Room = {
      id: roomId,
      name: `${hostName}'s Game`,
      host: hostId,
      state: 'lobby',
      players: {
        [hostId]: {
          id: hostId,
          name: hostName,
          role: null,
          team: null,
          status: 'active',
          createdAt: Date.now(),
        },
      },
      maxPlayers: 10,
      currentRound: 0,
      maxRounds: 5,
      votes: {},
      questTeam: [],
      questResults: [],
      failCount: 0,
      evilWins: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.rooms.set(roomId, room);
    return room;
  }

  public getRoom(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  public deleteRoom(roomId: string): void {
    this.rooms.delete(roomId);
  }

  public getAllRooms(): Room[] {
    return Array.from(this.rooms.values());
  }

  public updateRoom(roomId: string, room: Partial<Room>): Room | undefined {
    const existingRoom = this.rooms.get(roomId);
    if (!existingRoom) return undefined;

    const updated = {
      ...existingRoom,
      ...room,
      id: existingRoom.id, // Prevent ID change
      updatedAt: Date.now(),
    };

    this.rooms.set(roomId, updated);
    return updated;
  }
}
