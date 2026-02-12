# @orgloop/cli

Command-line interface for OrgLoop -- Organization as Code runtime. Validate configs, check environment, plan changes, and run the event loop.

## Install

```bash
npm install -g @orgloop/cli
```

## Commands

```
orgloop init              Scaffold a new orgloop.yaml (interactive)
orgloop validate          Validate config syntax and connector schemas
orgloop env               Check environment variables (shows missing with setup help)
orgloop doctor            System health check (connectors, services, credentials)
orgloop plan              Preview what start will do (sources, actors, routes)
orgloop start             Start the event loop
orgloop stop              Stop a running instance
orgloop status            Show runtime status
orgloop logs              View event logs
orgloop test              Dry-run a single event through the pipeline
orgloop routes            List configured routes
orgloop inspect           Inspect resolved config
orgloop add               Add a connector or module to config
orgloop hook              Manage lifecycle hooks
orgloop service           Manage background service
orgloop install-service   Install as a system service
orgloop version           Print version info
```

## Global flags

```
-c, --config <path>       Path to orgloop.yaml (default: ./orgloop.yaml)
-w, --workspace <name>    Workspace name (default: "default")
-v, --verbose             Verbose output
--json                    Machine-readable JSON output
--quiet                   Errors only
```

## Quick start

```bash
# Scaffold a new project
orgloop init

# Check your environment
orgloop env

# Validate the config
orgloop validate

# Preview the plan
orgloop plan

# Start routing events
orgloop start
```

## Documentation

Full documentation at [orgloop.ai](https://orgloop.ai)

## License

MIT
