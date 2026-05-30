# Atlas Hub Backend

Beginner PostgreSQL setup for an AI agent sharing platform.

This project currently includes only a Dockerized PostgreSQL database with:

- `users`
- `agents`
- `reviews`

No backend code, Prisma, authentication, or complex architecture has been added yet.

## Requirements

- Docker
- Docker Compose

## Setup

Copy the example environment file:

```bash
cp .env.example .env
```

Start PostgreSQL:

```bash
docker compose up -d
```

On first startup, Docker will run:

- `db/schema.sql` to create tables
- `db/seed.sql` to add sample data

## Connect to the Database

Use `psql` inside the running container:

```bash
docker compose exec postgres psql -U atlas_user -d atlas_hub
```

Try a simple query:

```sql
SELECT * FROM agents;
```

## Reset the Database

If you change `db/schema.sql` or `db/seed.sql`, reset the Docker volume so the init scripts run again:

```bash
docker compose down -v
docker compose up -d
```

## Files

- `docker-compose.yml` starts PostgreSQL and loads SQL init files.
- `db/schema.sql` defines the `users`, `agents`, and `reviews` tables.
- `db/seed.sql` adds beginner sample data.
- `.env.example` shows required database environment variables.
- `.gitignore` keeps local secrets and generated files out of Git.
