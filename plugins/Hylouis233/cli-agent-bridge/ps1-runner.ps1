# No param block: with -File, every token after the script path lands in
# $args as a literal string, so dashes, quotes, parentheses, and percent
# signs survive verbatim.
$Command = $args[0]
$rest = $args | Select-Object -Skip 1
& $Command @rest
exit $LASTEXITCODE

