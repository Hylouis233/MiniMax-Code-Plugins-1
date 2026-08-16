# No param block: with -File, every token after the script path lands in
# $args as a literal string, so dashes, quotes, parentheses, and percent
# signs survive verbatim.
$Command = $args[0]
$rest = $args | Select-Object -Skip 1
$ErrorActionPreference = "Stop"
$global:LASTEXITCODE = $null
try {
    & $Command @rest
    if ($null -eq $LASTEXITCODE) { exit 0 }
    exit [int]$LASTEXITCODE
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 127
}

