#!/usr/bin/env bash
# Install Ubuntu build dependencies without refreshing unrelated runner vendors.
# Repository signature and package hash verification remain enabled.
set -euo pipefail

if [[ -f /etc/apt/sources.list.d/ubuntu.sources ]]; then
  source_list=/etc/apt/sources.list.d/ubuntu.sources
elif [[ -s /etc/apt/sources.list ]]; then
  source_list=/etc/apt/sources.list
else
  echo 'No Ubuntu APT source list found; refusing an unverified fallback.' >&2
  exit 1
fi

apt_options=(-o "Dir::Etc::sourcelist=$source_list" -o 'Dir::Etc::sourceparts=-')
sudo apt-get "${apt_options[@]}" update
sudo apt-get "${apt_options[@]}" install -y "$@"
