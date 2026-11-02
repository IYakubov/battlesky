SKY FRONT — 3D browser warplane battle
======================================

The warplane twin of STEEL FRONT: same rooms, lobby, modes and sounds,
but fighter jets with mouse-aim flight, a cannon and lock-on missiles.

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
  Mouse: point where you want to fly — the jet turns to follow the circle
  Click: cannon (overheats)   Right-click / Q: missile   F: flares
  W/S: throttle   Shift: afterburner   A/D: rudder   C (hold): zoom   Wheel: camera
  Tab scores · Enter chat · M mute · Esc pause (host: back to lobby)
  Phones: left stick steers, drag right side to look, FIRE / BOOST / MISSILE / FLARES buttons.

COMBAT
  100 HP. Cannon rounds converge 360 m ahead (the gun cross); red diamond = lead marker.
  MISSILES: keep an enemy inside the dashed circle ~1.3 s to lock (rising beeps,
  then fast beeps = locked). Fire: the missile chases for 4 s with a limited turn
  rate, then flies straight and self-destructs. Hit = 45 damage. 2 missiles,
  one reloads every 8 s. Fired without a lock it flies straight.
  The target hears a warning ("ВАС ЗАХВАТЫВАЮТ" / "РАКЕТА!") with an arrow to the
  missile. Dodge with a hard turn, or drop flares (3 per life): missiles more than
  ~55 m away go for the flares instead.
  Flying into the ground or a building kills you; your last attacker (12 s) gets the kill.
  Green rings repair 35 HP and refill missiles + flares.

SOUNDS
  Gun, hit, ricochet, repair and victory sounds plus tank_epic.mp3 music
  come from the Tank War / Shared Couch game.
