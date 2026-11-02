SKY FRONT — 3D browser warplane battle
======================================

The warplane twin of STEEL FRONT: same rooms, lobby, modes and sounds,
but fighter planes with mouse-aim flight and machine guns.

RUN
  npm install
  npm start
  -> open http://localhost:3000   (Railway: start command "npm start", reads PORT)

PLAY
  Create game -> share the 6-digit code / invite link -> host presses Start.
    Team battle  — Alpha vs Bravo, no respawn, first to 3 rounds.
    Free-for-all — respawn after 5 s, first to 10 kills or 8 minutes.
  Up to 10 pilots. 1 player can start a practice flight.

CONTROLS
  Mouse: point where you want to fly — the plane turns to follow the circle
  Click: machine guns (they overheat)   W/S: throttle   Shift: boost
  A/D: rudder   Right-click: zoom   Wheel: camera distance
  Tab scores · Enter chat · M mute · Esc pause (host: back to lobby)
  Phones: left stick steers, drag right side to look, FIRE / BOOST buttons.

COMBAT
  100 HP. Bullets converge 300 m ahead of the nose (the gun cross).
  Red diamond = lead marker: put the gun cross on it to hit a moving plane.
  Engine/cockpit hits +30-40% damage, tail +15%, wings -25%.
  Flying into the ground or a building kills you — if someone shot you in
  the last 12 s, they get the kill. Too slow = stall, nose drops.
  Green rings in the sky repair 35 HP (respawn after 25 s).
  Hills block line of sight; enemies behind them vanish from map & markers.

SOUNDS
  Gun, hit, ricochet, repair and victory sounds plus tank_epic.mp3 music
  come from the Tank War / Shared Couch game.
