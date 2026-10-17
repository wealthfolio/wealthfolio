#!/bin/bash

# Default values
LOG_FILE="/tmp/wealthfolio-dev2.log"
MAX_ATTEMPTS=60
INTERVAL=2
TAIL_LINES=25
PORT=8088
FRONTEND_URL="${WF_E2E_BASE_URL:-http://localhost:1420}"

# Function to show usage
show_help() {
    echo "Usage: $0 [OPTIONS]"
    echo ""
    echo "Wait for both servers to answer HTTP requests, then show the end of the log file."
    echo ""
    echo "Options:"
    echo "  -l, --log-file LOG_FILE    Path to the log file (default: /tmp/wealthfolio-dev2.log)"
    echo "  -m, --max-attempts NUM     Maximum number of attempts (default: 60)"
    echo "  -i, --interval SEC         Interval between checks in seconds (default: 2)"
    echo "  -t, --tail-lines NUM       Number of lines to show at the end (default: 25)"
    echo "  -p, --port PORT            Port of the Axum server (default: 8088)"
    echo "  -h, --help                 Show this help message"
    echo ""
    echo "The script polls Vite at \$WF_E2E_BASE_URL (default: http://localhost:1420) and"
    echo "http://localhost:PORT/api/v1/healthz, and exits with status 1 if either"
    echo "does not answer within the given attempts."
}

# Parse options
while [[ $# -gt 0 ]]; do
    case $1 in
        -l|--log-file)
            LOG_FILE="$2"
            shift 2
            ;;
        -m|--max-attempts)
            MAX_ATTEMPTS="$2"
            shift 2
            ;;
        -i|--interval)
            INTERVAL="$2"
            shift 2
            ;;
        -t|--tail-lines)
            TAIL_LINES="$2"
            shift 2
            ;;
        -p|--port)
            PORT="$2"
            shift 2
            ;;
        -h|--help)
            show_help
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            show_help
            exit 1
            ;;
    esac
done

# Validate inputs
if ! [[ "$MAX_ATTEMPTS" =~ ^[0-9]+$ ]] || [ "$MAX_ATTEMPTS" -le 0 ]; then
    echo "Error: max-attempts must be a positive integer"
    exit 1
fi

if ! [[ "$INTERVAL" =~ ^[0-9]+$ ]] || [ "$INTERVAL" -le 0 ]; then
    echo "Error: interval must be a positive integer"
    exit 1
fi

if ! [[ "$TAIL_LINES" =~ ^[0-9]+$ ]] || [ "$TAIL_LINES" -lt 0 ]; then
    echo "Error: tail-lines must be a non-negative integer"
    exit 1
fi

if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [ "$PORT" -le 0 ] || [ "$PORT" -gt 65535 ]; then
    echo "Error: port must be an integer between 1 and 65535"
    exit 1
fi

# The server binds its port before it can serve requests, so poll over HTTP
# rather than checking that the port accepts connections.
responds() {
    curl -fs -o /dev/null --max-time "$INTERVAL" "$1"
}

# Wait loop
READY=false
for ((i=1; i<=MAX_ATTEMPTS; i++)); do
    if responds "$FRONTEND_URL" && responds "http://localhost:$PORT/api/v1/healthz"; then
        echo "Both servers ready after ${SECONDS}s"
        READY=true
        break
    fi
    sleep "$INTERVAL"
done

# Show tail of log
if [ -f "$LOG_FILE" ]; then
    tail -"$TAIL_LINES" "$LOG_FILE"
else
    echo "Log file $LOG_FILE does not exist or is not accessible."
fi

if [ "$READY" != true ]; then
    echo "Servers not ready after ${SECONDS}s; cargo may still be compiling. Run the script again to keep waiting." >&2
    exit 1
fi
