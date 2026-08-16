# No param block: with -File, every token after the script path lands in
# $args as a literal string, so dashes, quotes, parentheses, and percent
# signs survive verbatim.
$Command = $args[0]
$rest = $args | Select-Object -Skip 1
if ([string]::IsNullOrWhiteSpace($Command)) {
    [Console]::Error.WriteLine("backend command is missing")
    exit 127
}

try {
    $resolved = Get-Command -Name $Command -CommandType Application, ExternalScript -ErrorAction Stop
    $global:LASTEXITCODE = $null
    & $resolved.Source @rest
    if (-not $?) { exit 1 }
    if ($null -eq $LASTEXITCODE) { exit 0 }
    exit [int]$LASTEXITCODE
}
catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 127
}

