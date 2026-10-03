#!/bin/sh
set -eu
cd "$(dirname "$0")"
checks=$(mktemp -d)
trap 'rm -rf "$checks"' EXIT
grep -q '"/api/v1/service-info"' PS5LibraryCompanion/Store.swift
! grep -q 'masterUrl' PS5LibraryCompanion/Models.swift
! grep -q 'Master' PS5LibraryCompanion/PS5LibraryApp.swift
grep -q 'This companion only contacts the Library Node' PS5LibraryCompanion/PS5LibraryApp.swift
test "$(grep -c '\.tabItem' PS5LibraryCompanion/PS5LibraryApp.swift)" -eq 4
! grep -q 'Label("Discover"' PS5LibraryCompanion/PS5LibraryApp.swift
grep -q 'Picker("Location"' PS5LibraryCompanion/PS5LibraryApp.swift
grep -q 'struct LibraryGameRow' PS5LibraryCompanion/PS5LibraryApp.swift
grep -q 'private struct LibraryStage' PS5LibraryCompanion/PS5LibraryApp.swift
grep -q 'var contentMode:ContentMode = .fill' PS5LibraryCompanion/PS5LibraryApp.swift
test "$(grep -c 'ArtworkView(path:game.heroUrl,contentMode:.fit)' PS5LibraryCompanion/PS5LibraryApp.swift)" -eq 2
grep -q 'NavigationStack{ProfileView()}.tabItem' PS5LibraryCompanion/PS5LibraryApp.swift
grep -q 'let operation:BuildByteProgress?' PS5LibraryCompanion/Models.swift
test "$(grep -c 'INFOPLIST_KEY_NSAppTransportSecurity_NSAllowsLocalNetworking = YES' PS5LibraryCompanion.xcodeproj/project.pbxproj)" -eq 2
! grep -Eq '&&!|==\.' PS5LibraryCompanion/*.swift
if command -v swiftc >/dev/null 2>&1; then
  swiftc PS5LibraryCompanion/Models.swift Checks/main.swift -o "$checks/models"
  "$checks/models"
  swiftc -frontend -parse PS5LibraryCompanion/*.swift
else
  echo "swiftc unavailable; static iOS checks passed"
fi
