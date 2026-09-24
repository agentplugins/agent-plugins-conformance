#!/usr/bin/env node
0</* :
@node "%~dp0..\dist\probe.mjs" command-token decoy %*
@exit /b %errorlevel%
*/0;
process.argv.splice(2, 0, 'command-token', 'decoy');
import('../dist/probe.mjs');
