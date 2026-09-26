@echo off
node "%~dp0..\..\..\dist\probe.mjs" command-token-windows windows-cwd-exact intact %*
