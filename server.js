const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

// Раздаём статику из папки public (index.html и все твои картинки/plist)
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// ================= СЕРВЕРНАЯ БАЗА КАРТ И ЛОГИКА БОЯ =================
const LEVEL_MULTIPLIER = 1.1005;

const CARDS_DB = [
  { id: 'bomb', name: 'Bomb', type: 'spell', spellType: 'area_dmg', mana: 2, damage: 100, area: 2.8 },
  { id: 'warrior', name: 'Warrior', type: 'unit', mana: 3, hp: 294, damage: 107, speed: 1.45, range: 0.9, count: 1 },
  { id: 'archers', name: 'Archers', type: 'unit', mana: 1, hp: 80, damage: 20, speed: 1.0, range: 4.5, count: 2 },
  { id: 'skeletons', name: 'Skeletons', type: 'unit', mana: 1, hp: 80, damage: 20, speed: 1.15, range: 0.9, count: 3 },
  { id: 'stone', name: 'Stone Statue', type: 'unit', mana: 2, hp: 1000, damage: 0, speed: 0, range: 0, count: 1, canSpawnAnywhere: true },
  { id: 'dwarf', name: 'Dwarf', type: 'unit', mana: 2, hp: 450, damage: 20, speed: 1.15, range: 0.9, count: 1 },
  { id: 'golem', name: 'Golem', type: 'unit', mana: 2, hp: 450, damage: 20, speed: 1.15, range: 0.9, count: 1 },
  { id: 'heal', name: 'Heal', type: 'spell', spellType: 'heal', mana: 3, healPct: 0.63 },
  { id: 'growth', name: 'Growth', type: 'spell', spellType: 'growth', mana: 7, bonusPct: 0.65, scaleInc: 1.12, noLevelScale: true },
  { id: 'meteor', name: 'Meteor', type: 'spell', spellType: 'area_dmg', mana: 7, damage: 448, area: 2.8 },
  { id: 'rage', name: 'Rage', type: 'spell', spellType: 'rage', mana: 3, bonusDmg: 1.0, bonusSpd: 0.70, duration: 6.0, durationScale: 1.038 },
  { id: 'lightning', name: 'Lightning', type: 'spell', spellType: 'lightning', mana: 6, damage: 908 },
  { id: 'fire', name: 'Fire', type: 'spell', spellType: 'lane_dmg', mana: 6, damage: 224 },
  { id: 'blizzard', name: 'Blizzard', type: 'spell', spellType: 'blizzard', mana: 3, duration: 5.7 },
  { id: 'extra_crystal', name: 'Extra Crystal', type: 'spell', spellType: 'crystal', mana: 1, castleHpBonus: 318, manaGain: 2 },
  { id: 'wind', name: 'Wind', type: 'spell', spellType: 'wind', mana: 1 },
  { id: 'protection', name: 'Protection', type: 'spell', spellType: 'protection', mana: 3, shieldHp: 161 },
  { id: 'mud_elemental', name: 'Mud Elemental', type: 'unit', mana: 8, hp: 1089, damage: 339, speed: 0.72, range: 1.2, count: 1 },
  { id: 'spectre', name: 'Spectre', type: 'unit', mana: 6, hp: 443, damage: 65, speed: 0.72, range: 1.2, count: 1, bonusDmgSoul: 26, bonusHpSoul: 26 },
  { id: 'skull_king', name: 'Skull King', type: 'unit', mana: 10, hp: 999, damage: 114, speed: 0.72, range: 1.2, count: 1, spawnSkelPerLane: 4 },
  { id: 'cannon_shot', name: 'Cannon Shot', type: 'spell', spellType: 'cannon', mana: 2, castleDamage: 391 }
];

function getStat(baseVal, level) {
  return Math.round(baseVal * Math.pow(LEVEL_MULTIPLIER, Math.max(1, level) - 1));
}

function getCardScaledStats(cardId, level = 1) {
  const c = CARDS_DB.find(x => x.id === cardId);
  if (!c) return null;
  const lvl = Math.max(1, Number(level) || 1);
  const res = { ...c, level: lvl };
  if (c.hp) res.hp = getStat(c.hp, lvl);
  if (c.damage) res.damage = getStat(c.damage, lvl);
  if (c.castleHpBonus) res.castleHpBonus = getStat(c.castleHpBonus, lvl);
  if (c.shieldHp) res.shieldHp = getStat(c.shieldHp, lvl);
  if (c.castleDamage) res.castleDamage = getStat(c.castleDamage, lvl);
  if (c.bonusDmgSoul) res.bonusDmgSoul = getStat(c.bonusDmgSoul, lvl);
  if (c.bonusHpSoul) res.bonusHpSoul = getStat(c.bonusHpSoul, lvl);
  if (c.duration && c.durationScale) {
    res.duration = +(c.duration * Math.pow(c.durationScale, lvl - 1)).toFixed(2);
  }
  return res;
}

// ================= МАТЧМЕЙКИНГ И КОМНАТЫ =================
let waitingPlayer = null;
const rooms = new Map(); // roomId -> roomState

function createRoom(p1, p2) {
  const roomId = 'room_' + Math.random().toString(36).slice(2, 9);
  p1.socket.join(roomId);
  p2.socket.join(roomId);

  const p1CastleHp = getStat(2000, p1.castleLevel);
  const p2CastleHp = getStat(2000, p2.castleLevel);

  const shuffle = arr => [...arr].sort(() => Math.random() - 0.5);
  const d1 = shuffle(p1.deck);
  const d2 = shuffle(p2.deck);

  const room = {
    id: roomId,
    active: true,
    players: {
      p1: {
        socket: p1.socket,
        name: p1.name || 'Игрок 1',
        castleLevel: p1.castleLevel,
        cardLevels: p1.cardLevels,
        hp: p1CastleHp,
        maxHp: p1CastleHp,
        mana: 4.0,
        hand: d1.slice(0, 4),
        drawPile: d1.slice(4)
      },
      p2: {
        socket: p2.socket,
        name: p2.name || 'Игрок 2',
        castleLevel: p2.castleLevel,
        cardLevels: p2.cardLevels,
        hp: p2CastleHp,
        maxHp: p2CastleHp,
        mana: 4.0,
        hand: d2.slice(0, 4),
        drawPile: d2.slice(4)
      }
    },
    units: [],
    effects: [],
    cannonSprites: []
  };

  p1.socket.data.roomId = roomId;
  p1.socket.data.role = 'p1';
  p2.socket.data.roomId = roomId;
  p2.socket.data.role = 'p2';

  rooms.set(roomId, room);

  p1.socket.emit('match_found', {
    roomId,
    role: 'p1',
    yourName: room.players.p1.name,
    enemyName: room.players.p2.name,
    yourCastleLvl: p1.castleLevel,
    enemyCastleLvl: p2.castleLevel,
    hand: room.players.p1.hand
  });

  p2.socket.emit('match_found', {
    roomId,
    role: 'p2',
    yourName: room.players.p2.name,
    enemyName: room.players.p1.name,
    yourCastleLvl: p2.castleLevel,
    enemyCastleLvl: p1.castleLevel,
    hand: room.players.p2.hand
  });
}

function spawnUnit(room, cardStats, side, lane, tileX, offsetY = 0) {
  room.units.push({
    uid: Math.random().toString(36).slice(2),
    id: cardStats.id,
    side, // 'p1' (идёт вправо 0->16) или 'p2' (идёт влево 16->0)
    lane,
    tileX,
    offsetY,
    hp: cardStats.hp,
    maxHp: cardStats.hp,
    baseDamage: cardStats.damage,
    speed: cardStats.speed,
    range: cardStats.range,
    scale: 1.0,
    shieldHp: 0,
    shieldMaxHp: 0,
    freezeTimer: 0,
    rageTimer: 0,
    rageDmgBonus: 0,
    rageSpdBonus: 0,
    attackCooldown: 0,
    animState: 'deploy',
    animTimer: 0,
    deployTimer: (cardStats.id === 'spectre') ? 0.65 : 0
  });
}

function dealDamage(unit, amount) {
  if (amount <= 0 || unit.hp <= 0) return;
  if (unit.shieldHp > 0) {
    if (unit.shieldHp >= amount) {
      unit.shieldHp -= amount;
      return;
    } else {
      amount -= unit.shieldHp;
      unit.shieldHp = 0;
      unit.shieldMaxHp = 0;
    }
  }
  unit.hp -= amount;
}

function addEffect(room, type, lane, tileX, radiusTiles, color) {
  room.effects.push({ type, lane, tileX, radiusTiles, color, timer: 0.45, maxTimer: 0.45 });
}

function executeCardPlay(room, side, cardId, lane, tileX) {
  const playerObj = room.players[side];
  const enemySide = side === 'p1' ? 'p2' : 'p1';
  const enemyObj = room.players[enemySide];
  const cardLvl = playerObj.cardLevels[cardId] || 1;
  const st = getCardScaledStats(cardId, cardLvl);
  if (!st || playerObj.mana < st.mana) return false;

  lane = Math.max(0, Math.min(2, Number(lane) || 0));
  tileX = Number(tileX) || 0;

  if (st.type === 'unit') {
    if (!st.canSpawnAnywhere) {
      if (side === 'p1') tileX = Math.max(0.3, Math.min(7.8, tileX));
      else tileX = Math.max(8.2, Math.min(15.7, tileX));
    } else {
      tileX = Math.max(0.5, Math.min(15.5, tileX));
    }

    const count = st.count || 1;
    for (let i = 0; i < count; i++) {
      const spreadX = count > 1 ? (i - (count - 1) / 2) * 0.45 : 0;
      const spreadY = count > 1 ? ((i % 2 === 0 ? -1 : 1) * 14) : 0;
      const tx = Math.max(0.2, Math.min(15.8, tileX + spreadX));
      spawnUnit(room, st, side, lane, tx, spreadY);
    }

    if (st.spawnSkelPerLane) {
      const skelStats = getCardScaledStats('skeletons', cardLvl);
      for (let l = 0; l < 3; l++) {
        for (let k = 0; k < st.spawnSkelPerLane; k++) {
          const baseTx = side === 'p1' ? 1.2 : 14.8;
          const sx = baseTx + (side === 'p1' ? 1 : -1) * (k * 0.45);
          const sy = (k % 2 === 0 ? -16 : 16);
          spawnUnit(room, skelStats, side, l, sx, sy);
        }
      }
    }
    playerObj.mana -= st.mana;
    return true;
  }

  if (st.type === 'spell') {
    if (st.spellType === 'area_dmg') {
      const halfArea = st.area / 2;
      addEffect(room, 'explosion', lane, tileX, halfArea, st.id === 'meteor' ? '#f97316' : '#ef4444');
      room.units.forEach(u => {
        if (u.side === enemySide && u.lane === lane && Math.abs(u.tileX - tileX) <= halfArea) {
          dealDamage(u, st.damage);
        }
      });
      if (side === 'p1' && (16 - tileX) <= halfArea) enemyObj.hp -= st.damage;
      if (side === 'p2' && tileX <= halfArea) enemyObj.hp -= st.damage;
    }
    else if (st.spellType === 'lane_dmg') {
      addEffect(room, 'lane_flash', lane, 8, 0, 'rgba(239, 68, 68, 0.35)');
      room.units.forEach(u => {
        if (u.side === enemySide && u.lane === lane) dealDamage(u, st.damage);
      });
      enemyObj.hp -= st.damage;
    }
    else if (st.spellType === 'heal') {
      addEffect(room, 'lane_flash', lane, 8, 0, 'rgba(74, 222, 128, 0.3)');
      room.units.forEach(u => {
        if (u.side === side && u.lane === lane && u.hp > 0) {
          u.hp = Math.min(u.maxHp, u.hp + u.maxHp * st.healPct);
        }
      });
    }
    else if (st.spellType === 'growth') {
      const allies = room.units.filter(u => u.side === side && u.lane === lane && u.hp > 0);
      if (allies.length === 0) return false;
      allies.sort((a, b) => b.maxHp - a.maxHp);
      const target = allies[0];
      target.maxHp = Math.round(target.maxHp * (1 + st.bonusPct));
      target.hp = Math.round(target.hp * (1 + st.bonusPct));
      target.baseDamage = Math.round(target.baseDamage * (1 + st.bonusPct));
      target.scale *= st.scaleInc;
      addEffect(room, 'explosion', lane, target.tileX, 0.7, '#22c55e');
    }
    else if (st.spellType === 'rage') {
      addEffect(room, 'lane_flash', lane, 8, 0, 'rgba(168, 85, 247, 0.3)');
      room.units.forEach(u => {
        if (u.side === side && u.lane === lane && u.hp > 0) {
          u.rageTimer = st.duration;
          u.rageDmgBonus = st.bonusDmg;
          u.rageSpdBonus = st.bonusSpd;
        }
      });
    }
    else if (st.spellType === 'lightning') {
      const enemies = room.units.filter(u => u.side === enemySide && u.lane === lane && u.hp > 0);
      if (enemies.length === 0) return false;
      enemies.sort((a, b) => Math.abs(a.tileX - tileX) - Math.abs(b.tileX - tileX));
      const target = enemies[0];
      dealDamage(target, st.damage);
      addEffect(room, 'lightning', lane, target.tileX, 0.5, '#38bdf8');
    }
    else if (st.spellType === 'blizzard') {
      addEffect(room, 'lane_flash', lane, 8, 0, 'rgba(56, 189, 248, 0.35)');
      room.units.forEach(u => {
        if (u.side === enemySide && u.lane === lane && u.hp > 0) {
          u.freezeTimer = st.duration;
        }
      });
    }
    else if (st.spellType === 'crystal') {
      playerObj.mana = Math.min(10, playerObj.mana - st.mana + st.manaGain);
      playerObj.maxHp += st.castleHpBonus;
      playerObj.hp += st.castleHpBonus;
      addEffect(room, 'explosion', 1, side === 'p1' ? 0.5 : 15.5, 0.8, '#38bdf8');
      return true;
    }
    else if (st.spellType === 'wind') {
      addEffect(room, 'lane_flash', lane, 8, 0, 'rgba(226, 232, 240, 0.35)');
      room.units.forEach(u => {
        if (u.lane === lane && u.hp > 0) {
          u.tileX = u.side === 'p1' ? 0.4 : 15.6;
        }
      });
    }
    else if (st.spellType === 'protection') {
      addEffect(room, 'lane_flash', lane, 8, 0, 'rgba(34, 197, 94, 0.25)');
      room.units.forEach(u => {
        if (u.side === side && u.lane === lane && u.hp > 0) {
          u.shieldHp = st.shieldHp;
          u.shieldMaxHp = st.shieldHp;
        }
      });
    }
    else if (st.spellType === 'cannon') {
      enemyObj.hp -= st.castleDamage;
      room.cannonSprites.push({ side, timer: 1.2 });
      addEffect(room, 'explosion', 1, side === 'p1' ? 15.8 : 0.2, 0.9, '#f59e0b');
    }

    playerObj.mana -= st.mana;
    return true;
  }
  return false;
}

// Игровой тик на сервере (20 раз в секунду)
const TICK_RATE = 20;
const DT = 1 / TICK_RATE;

setInterval(() => {
  for (const [roomId, room] of rooms.entries()) {
    if (!room.active) continue;

    const p1 = room.players.p1;
    const p2 = room.players.p2;

    p1.mana = Math.min(10, p1.mana + DT * 0.72);
    p2.mana = Math.min(10, p2.mana + DT * 0.72);

    room.effects.forEach(ef => ef.timer -= DT);
    room.effects = room.effects.filter(ef => ef.timer > 0);
    room.cannonSprites.forEach(cs => cs.timer -= DT);
    room.cannonSprites = room.cannonSprites.filter(cs => cs.timer > 0);

    for (const u of room.units) {
      if (u.hp <= 0) continue;

      if (u.deployTimer > 0) {
        u.deployTimer -= DT;
        u.animState = 'deploy';
        u.animTimer += DT;
        continue;
      }

      if (u.freezeTimer > 0) {
        u.freezeTimer -= DT;
        continue;
      }

      if (u.rageTimer > 0) {
        u.rageTimer -= DT;
      } else {
        u.rageDmgBonus = 0;
        u.rageSpdBonus = 0;
      }

      const dir = u.side === 'p1' ? 1 : -1;
      const enemySide = u.side === 'p1' ? 'p2' : 'p1';

      let currentDmg = u.baseDamage;
      if (u.id === 'mud_elemental') {
        const hpRatio = Math.max(0.15, u.hp / u.maxHp);
        currentDmg = Math.round(u.baseDamage * hpRatio);
      }
      currentDmg = Math.round(currentDmg * (1 + u.rageDmgBonus));

      let targetEnemy = null;
      let minDist = Infinity;
      for (const other of room.units) {
        if (other.side === enemySide && other.lane === u.lane && other.hp > 0) {
          const dist = (other.tileX - u.tileX) * dir;
          if (dist >= -0.3 && dist < minDist) {
            minDist = dist;
            targetEnemy = other;
          }
        }
      }

      const distToCastle = u.side === 'p1' ? (16 - u.tileX) : u.tileX;

      if (u.baseDamage > 0 && u.range > 0) {
        if (targetEnemy && minDist <= u.range) {
          u.animState = 'attack';
          u.animTimer += DT;
          u.attackCooldown -= DT;
          if (u.attackCooldown <= 0) {
            u.attackCooldown = 1.0;
            dealDamage(targetEnemy, currentDmg);
          }
          continue;
        } else if (distToCastle <= u.range) {
          u.animState = 'attack';
          u.animTimer += DT;
          u.attackCooldown -= DT;
          if (u.attackCooldown <= 0) {
            u.attackCooldown = 1.0;
            room.players[enemySide].hp -= currentDmg;
          }
          continue;
        }
      }

      if (u.speed > 0) {
        u.animState = 'walk';
        u.animTimer += DT;
        const spd = u.speed * (1 + u.rageSpdBonus);
        u.tileX += dir * spd * DT;
        u.tileX = Math.max(0, Math.min(16, u.tileX));
      }
    }

    // Пассивка Spectre
    const deadUnits = room.units.filter(u => u.hp <= 0);
    if (deadUnits.length > 0) {
      deadUnits.forEach(dead => {
        room.units.forEach(alive => {
          if (alive.hp > 0 && alive.id === 'spectre' && alive.side === dead.side && alive.uid !== dead.uid) {
            const lvl = room.players[alive.side].cardLevels['spectre'] || 1;
            const st = getCardScaledStats('spectre', lvl);
            alive.baseDamage += st.bonusDmgSoul;
            alive.maxHp += st.bonusHpSoul;
            alive.hp += st.bonusHpSoul;
            alive.scale = Math.min(1.8, alive.scale + 0.04);
            addEffect(room, 'explosion', alive.lane, alive.tileX, 0.45, '#a855f7');
          }
        });
      });
      room.units = room.units.filter(u => u.hp > 0);
    }

    // Отправка состояния обоим игрокам
    const payload = {
      p1: { hp: Math.max(0, Math.round(p1.hp)), maxHp: Math.round(p1.maxHp), mana: +p1.mana.toFixed(2) },
      p2: { hp: Math.max(0, Math.round(p2.hp)), maxHp: Math.round(p2.maxHp), mana: +p2.mana.toFixed(2) },
      units: room.units,
      effects: room.effects,
      cannonSprites: room.cannonSprites
    };
    io.to(roomId).emit('state_update', payload);

    // Проверка конца боя
    if (p1.hp <= 0 || p2.hp <= 0) {
      room.active = false;
      const winner = p2.hp <= 0 ? 'p1' : 'p2';
      io.to(roomId).emit('game_over', { winner });
      rooms.delete(roomId);
    }
  }
}, 1000 / TICK_RATE);

// ================= ОБРАБОТКА ПОДКЛЮЧЕНИЙ SOCKET.IO =================
io.on('connection', socket => {
  socket.on('find_match', data => {
    if (!data || !Array.isArray(data.deck) || data.deck.length !== 14) return;
    if (waitingPlayer && waitingPlayer.socket.id === socket.id) return;

    const playerInfo = {
      socket,
      name: String(data.name || 'Боец').slice(0, 18),
      castleLevel: Math.max(1, Number(data.castleLevel) || 1),
      cardLevels: data.cardLevels || {},
      deck: data.deck
    };

    if (waitingPlayer && waitingPlayer.socket.connected) {
      const opponent = waitingPlayer;
      waitingPlayer = null;
      createRoom(opponent, playerInfo);
    } else {
      waitingPlayer = playerInfo;
      socket.emit('waiting_opponent');
    }
  });

  socket.on('cancel_search', () => {
    if (waitingPlayer && waitingPlayer.socket.id === socket.id) {
      waitingPlayer = null;
    }
  });

  socket.on('play_card', ({ handIdx, lane, tileX }) => {
    const roomId = socket.data.roomId;
    const role = socket.data.role;
    const room = rooms.get(roomId);
    if (!room || !room.active) return;

    const pObj = room.players[role];
    if (handIdx < 0 || handIdx >= pObj.hand.length) return;
    const cardId = pObj.hand[handIdx];

    // Игрок 2 видит поле зеркально (свой замок слева), поэтому переводим его координату в серверную (16 - tileX)
    const serverTileX = role === 'p1' ? tileX : (16 - tileX);

    if (executeCardPlay(room, role, cardId, lane, serverTileX)) {
      pObj.drawPile.push(cardId);
      pObj.hand[handIdx] = pObj.drawPile.shift();
      socket.emit('hand_update', pObj.hand);
    }
  });

  socket.on('surrender', () => {
    const roomId = socket.data.roomId;
    const role = socket.data.role;
    const room = rooms.get(roomId);
    if (!room || !room.active) return;
    room.active = false;
    const winner = role === 'p1' ? 'p2' : 'p1';
    io.to(roomId).emit('game_over', { winner, reason: 'surrender' });
    rooms.delete(roomId);
  });

  socket.on('disconnect', () => {
    if (waitingPlayer && waitingPlayer.socket.id === socket.id) {
      waitingPlayer = null;
    }
    const roomId = socket.data.roomId;
    const role = socket.data.role;
    const room = rooms.get(roomId);
    if (room && room.active) {
      room.active = false;
      const winner = role === 'p1' ? 'p2' : 'p1';
      io.to(roomId).emit('game_over', { winner, reason: 'disconnect' });
      rooms.delete(roomId);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Castle Crush Online Server running on port ${PORT}`);
});
