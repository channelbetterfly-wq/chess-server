const http = require("http");
const WebSocket = require("ws");
const PORT = process.env.PORT || 8080;

// Обычный HTTP-сервер рядом с WebSocket нужен по двум причинам:
// облачные хостинги (Render, Railway, Fly) проверяют живость сервиса
// GET-запросом и усыпляют его, если порт не отвечает по HTTP; плюс так
// удобно проверить в браузере, что сервер поднялся.
const httpServer = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      lobby: lobby.length,
      games: Object.keys(games).length,
      uptime: Math.floor(process.uptime())
    }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocket.Server({ server: httpServer });
httpServer.listen(PORT);

let lobby = [];       // [{id, ws, name, elo, avatar, createdAt}]
let games = {};       // gameId -> {white, black, ...}
let idCounter = 1;

const LOBBY_TTL_MS = 5 * 60 * 1000;   // сколько живёт неподхваченная заявка

// Контроли времени должны совпадать с TIME_CONTROLS в клиенте (Main.gd).
// Секунды на всю партию. moveTime — мягкий лимит на ход, масштабируем от
// базы, чтобы у пули он был короткий, а у классики — большой.
const TIME_CONTROLS = {
  bullet:   { seconds: 60,   moveTime: 10 },
  blitz:    { seconds: 180,  moveTime: 20 },
  rapid:    { seconds: 600,  moveTime: 60 },
  classic:  { seconds: 1800, moveTime: 120 },
  marathon: { seconds: 3600, moveTime: 300 },
};
function tcOf(id) { return TIME_CONTROLS[id] || TIME_CONTROLS.rapid; }

console.log("♔ Chess Academy Server v4 — lobby on port " + PORT);

wss.on("connection", (ws) => {
  ws._alive = true; ws._gameId = null; ws._color = null; ws._name = "";

  ws.on("message", (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }
    switch (data.type) {
      case "create_game":
        createLobbyGame(ws, data); break;
      case "join_game":
        joinLobbyGame(ws, data); break;
      case "list_games":
        sendLobbyList(ws); break;
      case "cancel_game":
        cancelLobbyGame(ws); break;
      case "invite_friend":
        handleInvite(ws, data); break;
      case "move":
        relayToOpponent(ws, data); break;
      case "sticker":
        relayToOpponent(ws, data); break;
      case "time_update":
        relayToOpponent(ws, data); break;
      case "resign":
        handleResign(ws); break;
    }
  });

  ws.on("close", () => {
    removeLobby(ws);
    handleDisconnect(ws);
  });
  ws.on("pong", () => { ws._alive = true; });
});

function createLobbyGame(ws, data) {
  removeLobby(ws);
  const entry = {
    id: "L" + (idCounter++),
    ws, name: data.name || "Player",
    elo: parseInt(data.elo) || 800,
    avatar: data.avatar || "0",
    createdAt: Date.now(),
    friendOnly: data.friendOnly || false,
    friendCode: data.friendCode || "",
    tc: TIME_CONTROLS[data.tc] ? data.tc : "rapid"
  };
  ws._name = entry.name;
  lobby.push(entry);
  ws.send(JSON.stringify({type: "game_created", lobbyId: entry.id}));
  broadcastLobby();
}

function joinLobbyGame(ws, data) {
  const lid = data.lobbyId;
  const entry = lobby.find(e => e.id === lid);
  if (!entry) {
    ws.send(JSON.stringify({type: "error", message: "Game not found"}));
    return;
  }
  // Remove from lobby
  lobby = lobby.filter(e => e.id !== lid);
  broadcastLobby();
  // Create game
  const gid = "G" + (idCounter++);
  const flip = Math.random() < 0.5;
  const w = flip ? entry : {ws, name: data.name||"Player", elo: parseInt(data.elo)||800, avatar: data.avatar||"0"};
  const b = flip ? {ws, name: data.name||"Player", elo: parseInt(data.elo)||800, avatar: data.avatar||"0"} : entry;
  games[gid] = {white: w.ws, black: b.ws, wName: w.name, bName: b.name};
  w.ws._gameId = gid; w.ws._color = "w";
  b.ws._gameId = gid; b.ws._color = "b";
  // Контроль времени берём из заявки создателя — он его выбрал.
  const tc = tcOf(entry.tc);
  const base = {type:"match_found", gameId:gid,
    whiteTime:tc.seconds, blackTime:tc.seconds, moveTime:tc.moveTime, tc:entry.tc};
  safeSend(w.ws, {...base, color:"w", opponentName:b.name, opponentElo:b.elo, opponentAvatar:b.avatar});
  safeSend(b.ws, {...base, color:"b", opponentName:w.name, opponentElo:w.elo, opponentAvatar:w.avatar});
}

function sendLobbyList(ws) {
  const list = lobby.filter(e => !e.friendOnly).map(e => ({
    id: e.id, name: e.name, elo: e.elo, avatar: e.avatar,
    waited: Math.floor((Date.now() - e.createdAt) / 1000), tc: e.tc || "rapid"
  }));
  ws.send(JSON.stringify({type: "lobby_list", games: list}));
}

function cancelLobbyGame(ws) {
  removeLobby(ws);
  ws.send(JSON.stringify({type: "game_cancelled"}));
  broadcastLobby();
}

function handleInvite(ws, data) {
  // Find player by friend code in lobby
  const code = data.friendCode || "";
  const entry = lobby.find(e => e.friendCode === code && e.friendOnly);
  if (entry) {
    // Auto-join the friend's game
    joinLobbyGame(ws, {lobbyId: entry.id, name: data.name, elo: data.elo, avatar: data.avatar});
  } else {
    ws.send(JSON.stringify({type: "error", message: "Friend game not found"}));
  }
}

function relayToOpponent(ws, data) {
  const g = games[ws._gameId];
  if (!g) return;
  const opp = ws._color === "w" ? g.black : g.white;
  safeSend(opp, data);
}

function handleResign(ws) {
  const g = games[ws._gameId];
  if (!g) return;
  const opp = ws._color === "w" ? g.black : g.white;
  const winner = ws._color === "w" ? "b" : "w";
  safeSend(opp, {type:"game_over", reason:"resign", winner});
  safeSend(ws, {type:"game_over", reason:"resign", winner});
  delete games[ws._gameId];
  ws._gameId = null; if(opp) opp._gameId = null;
}

function handleDisconnect(ws) {
  const gid = ws._gameId;
  if (!gid || !games[gid]) return;
  const g = games[gid];
  const opp = ws._color === "w" ? g.black : g.white;
  safeSend(opp, {type:"game_over", reason:"disconnect", winner: ws._color==="w"?"b":"w"});
  if(opp) opp._gameId = null;
  delete games[gid];
}

function removeLobby(ws) {
  lobby = lobby.filter(e => e.ws !== ws);
}

function broadcastLobby() {
  const list = lobby.filter(e => !e.friendOnly).map(e => ({
    id: e.id, name: e.name, elo: e.elo, avatar: e.avatar,
    waited: Math.floor((Date.now() - e.createdAt) / 1000), tc: e.tc || "rapid"
  }));
  const msg = JSON.stringify({type: "lobby_list", games: list});
  wss.clients.forEach(c => { if(c.readyState === WebSocket.OPEN) c.send(msg); });
}

function safeSend(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws._alive) return ws.terminate();
    ws._alive = false; ws.ping();
  });
}, 30000);

// Заявки, к которым за пять минут никто не присоединился, снимаем:
// иначе список постепенно заполняется «мёртвыми» играми людей, которые
// давно закрыли приложение, и живого соперника в нём не найти.
setInterval(() => {
  const now = Date.now();
  const before = lobby.length;
  lobby = lobby.filter(e => {
    const alive = e.ws && e.ws.readyState === WebSocket.OPEN;
    const fresh = now - e.createdAt < LOBBY_TTL_MS;
    if (alive && !fresh) safeSend(e.ws, { type: "game_cancelled", reason: "timeout" });
    return alive && fresh;
  });
  if (lobby.length !== before) broadcastLobby();
}, 15000);

// Refresh lobby periodically
setInterval(() => broadcastLobby(), 5000);
