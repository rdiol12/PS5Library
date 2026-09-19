#!/bin/sh
set -eu
cd "$(dirname "$0")"
checks=$(mktemp -d)
trap 'rm -rf "$checks"' EXIT
swiftc PS5LibraryCompanion/Models.swift Checks/main.swift -o "$checks/models"
"$checks/models"
swiftc -frontend -parse PS5LibraryCompanion/*.swift
test "$(grep -c 'INFOPLIST_KEY_NSAppTransportSecurity_NSAllowsLocalNetworking = YES' PS5LibraryCompanion.xcodeproj/project.pbxproj)" -eq 2
