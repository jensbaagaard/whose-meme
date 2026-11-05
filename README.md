# Whose Meme?

A party game for one big screen and a bunch of phones.

1. Open **`/host`** on the TV/laptop. It shows a room code and a QR code.
2. Everyone joins on their phone, **takes a selfie** and pastes links to memes (TikTok, Instagram, YouTube, Reddit, anything; it's just a link).
3. The host starts the game. The big screen shows one random meme link at a time; click it to open the meme.
4. Everyone taps the **face** of whoever they think posted it. The uploader has to pick someone too, as a bluff, so nobody can tell from the locked-in count.
5. Once everyone has locked in (or the host hits *Reveal now*), the big screen shows who it was and who guessed what.

**Scoring:** +1 for a correct guess, and the uploader gets +1 for every player they fooled.

## Run locally

```sh
npm install
npm start            # http://localhost:3000, host screen at /host
npm test             # game rules + a full game over real sockets
```

To try it with real phones on your Wi-Fi, open `http://<your-laptop-ip>:3000/host` on the laptop so the QR code points at an address the phones can reach. Selfies use the phone's camera picker (`<input capture>`), which works over plain HTTP too.

## Config

| Env var                | Default   | What it does                                     |
| ---------------------- | --------- | ------------------------------------------------ |
| `PORT`                 | `3000`    | HTTP port                                        |
| `HOST`                 | `0.0.0.0` | Bind address (`127.0.0.1` behind nginx)          |
| `ROOM_TTL_HOURS`       | `3`       | Rooms with no activity for this long are deleted |
| `MAX_ROOMS`            | `500`     | Cap on simultaneous rooms                        |
| `MAX_PLAYERS_PER_ROOM` | `16`      |                                                  |
| `MAX_MEMES_PER_PLAYER` | `10`      |                                                  |

Everything is kept in memory, with no database. Restarting the server ends any running games.

## Deploy on a droplet (Ubuntu)

```sh
# Node 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs nginx

# App
sudo useradd --system --home /opt/whose-meme whosememe
sudo git clone https://github.com/<owner>/whose-meme.git /opt/whose-meme
cd /opt/whose-meme && sudo npm ci --omit=dev

# Service (see deploy/whose-meme.service)
sudo cp deploy/whose-meme.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now whose-meme
curl localhost:3000/healthz

# nginx + HTTPS (see deploy/nginx.conf; set your domain in it first)
sudo cp deploy/nginx.conf /etc/nginx/sites-available/whose-meme
sudo ln -s /etc/nginx/sites-available/whose-meme /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d memes.example.com
```

Updating by hand: `cd /opt/whose-meme && sudo git pull && sudo npm ci --omit=dev && sudo systemctl restart whose-meme`.

CI (`.github/workflows/ci.yml`) runs the tests on every push and pull request.

## Layout

- `server.js`: Express + Socket.IO, room codes, QR and avatar endpoints
- `src/game.js`: the game rules and what each screen is allowed to see (pure, no sockets)
- `public/`: plain HTML/CSS/JS, no build step (`index.html` is the phone, `host.html` the big screen)
