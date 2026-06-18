# Default Auto Runs to Docker

Auto Runs execute mini-swe-agent in a fully autonomous loop, so they use mini-swe-agent's Docker environment by default instead of local shell execution. Local execution remains an explicit advanced opt-in because it gives the agent unrestricted command access on the host machine, while Docker gives Thrush a clearer safety boundary for the default product experience.
