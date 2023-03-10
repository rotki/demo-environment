# @rotki/demo-environment

A proxy that can be used between [rotki](https://github.com/rotki/rotki) and a public user facing url to create a read-only demo of the application.

## Usage

### Installation

```bash
pnpm install
````

### Linting

```bash
pnpm run lint
```

#### Fixing lint errors

```bash
pnpm run lint:fix
```

### Building 

```bash
pnpm run build
```

### Development mode

In development mode you will need to manually start the [rotki docker image](https://rotki.readthedocs.io/en/stable/installation_guide.html#docker).
If the changes you are doing affect develop, you might need to [build the docker image](https://rotki.readthedocs.io/en/stable/installation_guide.html#id15).

After building or pulling the image, you need to start the container.
As soon as the container is running update the .env file to point to the rotki container.

If you exposed rotki at port `8084` in the .env file you should set `ROTKI_URL=http://localhost:8084`.
Then you need to set the listening port for the proxy too, `PORT=8899`

After that you can run the following command:

```bash
pnpm run dev
```

Now you should be able to access rotki through the proxy via `http://localhost:8899`.

## License

[AGPL-3.0](./LICENSE) License &copy; 2023- [Rotki Solutions GmbH](https://github.com/rotki)