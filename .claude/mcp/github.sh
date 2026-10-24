#!/bin/sh
# Start GitHub's official MCP server (read-only, search/read tools only) for
# Claude Code. The token comes from the existing `gh` login at start-up, so it
# is never written to .mcp.json or any other file.
set -eu
GITHUB_PERSONAL_ACCESS_TOKEN=$(gh auth token)
export GITHUB_PERSONAL_ACCESS_TOKEN
exec github-mcp-server stdio --read-only \
  --tools search_repositories,search_code,get_file_contents,list_commits,list_releases,get_latest_release,list_tags
