# Bundle mini-swe-agent with Thrush

Thrush Auto Mode should prefer a bundled mini-swe-agent checkout, such as `vendor/mini-swe-agent`, so users can clone Thrush and try Auto without manually installing mini first. The bundled copy should be managed as a Git submodule or clearly tracked vendored dependency so upgrades remain auditable instead of copying opaque source into the application tree.
