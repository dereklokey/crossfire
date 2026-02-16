# Crossfire

Real-time web game with single-player AI and network multiplayer.

## Run

```bash
cd ~/Work/Codex/Crossfire
npm start
```

Open `http://127.0.0.1:3000`.

## LAN multiplayer

To allow another machine on your network to join:

```bash
HOST=0.0.0.0 PORT=3000 npm start
```

Then share your machine IP + room code (for example `http://192.168.1.20:3000`).

## Rules implemented

- Fixed guns at each end, rotatable aim.
- Goal lines near each side.
- `3/5/7/random` center pieces.
- First to majority pieces wins.
- Total ammo pool is conserved (`50` total).
- Magazine size `20`, reload is fast but not instant.
- Ammo crossing a goal is collected into that side's bin.
- Single-player AI with `easy/medium/hard`.

## Multiplayer flow

- Host creates room and shares room ID.
- Guest joins room using the room ID.
- Host presses `Start Match` when both players are ready.
- After a match ends, host can press `Rematch` and reuse the same room ID.
