# MongoDB Atlas setup

The app talks to MongoDB through Mongoose, so only `MONGODB_URI` changes between local and Atlas.

## 1. Create an Atlas account and cluster
1. Go to <https://www.mongodb.com/atlas> and sign up (Google or email).
2. Create a free **M0** cluster. Pick the region closest to you.

## 2. Database user
Under **Database Access**, add a database user with a username and password
(role: *Read and write to any database*). Avoid special characters in the password, or URL-encode them.

## 3. Network access
Under **Network Access**, add your current IP address.
For development only you may use `0.0.0.0/0` (allow from anywhere). Do not do this for production.

## 4. Copy the connection string
Click **Connect**, then **Drivers**, and copy the `mongodb+srv://...` URI. Replace `<password>` with your
database user's password and add the database name before the `?`:

```
mongodb+srv://<user>:<password>@<cluster>.mongodb.net/pss?retryWrites=true&w=majority
```

## 5. Configure the app
Put the URI in `.env.local` (never commit this file; it is gitignored):

```
MONGODB_URI=mongodb+srv://<user>:<password>@<cluster>.mongodb.net/pss?retryWrites=true&w=majority
JWT_SECRET=<long random string>
```

See `.env.example` for all variables.

## 6. Verify
```powershell
npm run dev
# in another terminal:
curl http://localhost:3000/api/health
```
Expected: `{"status":"ok","db":"up"}`. A `503` with `{"status":"error","db":"down"}` means the DB is
unreachable: check the URI, the password, and the IP allowlist.

Then load the demo data (users, flights, fares, inventory and demo bookings) with `npm run seed`.
`npm run seed -- --reset` removes and recreates only the demo bookings and the demo flight. The seed writes to the
database in `.env.local`, so check the "Target database" line it prints first. See the README for details.

## Running against a local MongoDB meanwhile
No Atlas account is needed to develop.

- **Local install:** install MongoDB Community Server and start it, then use the default in `.env.local`:
  `MONGODB_URI=mongodb://127.0.0.1:27017/pss`
- **Docker:** `docker run -d --name pss-mongo -p 27017:27017 mongo:7`
- **Tests:** `npm test` needs no database. It uses `mongodb-memory-server`, which downloads a MongoDB binary
  on first run (set `TEST_MONGODB_URI` to use an existing instance instead).

When your Atlas cluster is ready, just replace `MONGODB_URI`. No code changes are needed.
