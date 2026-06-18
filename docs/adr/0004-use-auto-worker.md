# Use an Auto Worker for Auto Runs

Auto Runs are long-running autonomous jobs, so Thrush uses a local Auto Worker to claim queued runs, manage mini-swe-agent processes, handle cancellation, and write events and artifacts. Keeping this separate from request handling avoids treating a long-running agent run as a single API request and leaves room for recovery, queueing, and future controlled concurrency.
