# Eternity Cluster Archive

A dockerised service for hosting the archive of saves from the Eternity Cluster.

## Mirrors

The archive is currently available on these mirrors:

- https://www.hornwitser.no/eternity-saves/ (100 Mbit/s)
- https://wildwolf.dev/eternity-saves/ (~400 Mbit/s cached on Cloudflare)
- https://a.d-a.fi/ (1 Gbit/s)

### Host a mirror

If you would like to host your own mirror you can obtain all the files with the following commands.

```sh
MIRROR=url-from-above
wget "${MIRROR}/files?format=plain" -O files.txt
wget --input-file=files.txt --force-directories --no-host-directories --cut-dirs=1 --directory-prefix=public/
rm files.txt
```

To host the service providing easy access to the files you can use docker compose with the following config.

```yaml
services:
  eternity-saves:
    image: ghcr.io/hornwitser/eternity-cluster-archive:master
    init: true
    ports:
      - 8000:8000
    volumes:
      - ./public:/public:ro
    environment:
      PUBLIC_URL: https://www.example.com/eternity-saves # Modify this to match your server's url
```

Once you have your own mirror up and running please inform Hornwitser about it so that it can be added to the list of mirrors here.
