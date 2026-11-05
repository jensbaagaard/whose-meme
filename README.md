# Whose Meme?

A party game for one big screen and a bunch of phones.

1. Open **`/host`** on the TV/laptop. It shows a room code and a QR code.
2. Everyone joins on their phone, **takes a selfie** and adds memes: paste links (TikTok, Instagram, YouTube, Reddit, anything; it's just a link) or upload images and GIFs from the phone's gallery.
3. The host starts the game. The big screen shows one random meme at a time: images show right there, links are a big button to click.
4. Everyone taps the **face** of whoever they think posted it. The uploader has to pick someone too, as a bluff, so nobody can tell from the locked-in count.
5. Once everyone has locked in (or the host hits *Reveal now*), the big screen shows who it was and who guessed what.
6. **The doodle:** one random correct guesser picks someone else's face and vandalises it on their phone with a pen, emoji stickers and a new name. Everyone watches it happen live on the big screen, and the victim's phone says "😱 … is drawing on YOUR face!". The result becomes that player's photo and name for the rest of the game (15s to pick, 45s to draw; the host can skip).

**Scoring:** +1 for a correct guess, and the uploader gets +1 for every player they fooled.

**Other silly bits:** 🎲 random silly names, renaming yourself in the lobby (tap your name), emoji reactions from phones that float up the big screen with your face on them, confetti, and awards at the end (🕵️ Sherlock, 🎭 Master of Disguise, 🤡 Most Gullible, 🎨 Picasso, 🖍️ Human Canvas).

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
| `DATA_DIR`             | `./data`  | Where running games are saved                    |
| `ROOM_TTL_HOURS`       | `3`       | Rooms with no activity for this long are deleted |
| `MAX_ROOMS`            | `500`     | Cap on simultaneous rooms                        |
| `MAX_PLAYERS_PER_ROOM` | `16`      |                                                  |
| `MAX_MEMES_PER_PLAYER` | `10`      | Links and images together                        |
| `MAX_ROOM_MEDIA_MB`    | `150`     | Uploaded images per room                         |
| `MAX_MEDIA_MB`         | `2048`    | Uploaded images across all rooms (disk guard)    |

Rooms are saved to disk as one JSON file per room in `DATA_DIR`, with changes batched about every 200ms. On startup the server loads them back. Phones and the main screen reconnect on their own and land back in the same round, with scores and guesses intact. A normal restart (SIGTERM, as `systemctl restart` sends) writes out pending changes first; a hard crash loses at most the last ~200ms. Room files include the selfies and are deleted when the room expires.

Uploaded meme images are stored as files in `DATA_DIR/media/<room>/`, never in the room JSON. Phones shrink still images to at most 1600px before uploading (a 12MP photo ends up around 100–300KB); GIFs are uploaded as they are so they keep animating (max 6MB). The server checks the file's actual bytes and only accepts JPEG, PNG, GIF and WebP. Images are deleted when their meme is removed, on *Play again*, when the player leaves, and when the room expires. If you put the app behind nginx, raise `client_max_body_size` (the included config sets `8m`); nginx's default of 1MB rejects bigger uploads.

## Deploy on a droplet (Ubuntu)

```sh
# Node 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs nginx

# App
sudo useradd --system --home /opt/whose-meme whosememe
sudo git clone https://github.com/jensbaagaard/whose-meme.git /opt/whose-meme
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

Updating by hand (running games survive this): `cd /opt/whose-meme && sudo git pull && sudo npm ci --omit=dev && sudo systemctl restart whose-meme`.

CI (`.github/workflows/ci.yml`) runs the tests on every push and pull request.

## Layout

- `server.js`: Express + Socket.IO, room codes, QR, avatar and image upload endpoints
- `src/game.js`: the game rules and what each screen is allowed to see (pure, no sockets)
- `src/store.js`: saves rooms and uploaded images to `DATA_DIR` and loads them on startup
- `public/`: plain HTML/CSS/JS, no build step (`index.html` is the phone, `host.html` the big screen)
