#!/usr/bin/env node
0</* :
@node "%~dp0..\dist\probe.mjs" command-token exact %*
@exit /b %errorlevel%
*/0;
process.argv.splice(2, 0, 'command-token', 'exact');
import('../dist/probe.mjs');
