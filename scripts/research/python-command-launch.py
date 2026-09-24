import asyncio
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import shutil
import tempfile

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp.os.win32.utilities import get_windows_executable_command

ARGS = ['arg with spaces', '', 'literal-value']

def errors(exc):
    if isinstance(exc, BaseExceptionGroup):
        return [item for child in exc.exceptions for item in errors(child)]
    return [{'type': type(exc).__name__, 'message': str(exc), 'winerror': getattr(exc, 'winerror', None)}]

async def attempt(root, filename):
    command = str(root / 'bin' / filename)
    result = {'command': command, 'resolved': get_windows_executable_command(command)}
    try:
        async with asyncio.timeout(30):
            async with stdio_client(StdioServerParameters(command=command, args=ARGS, cwd=str(root))) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    listing = await session.list_tools()
                    assert [tool.name for tool in listing.tools] == ['observe']
                    observation = await session.call_tool('observe', {})
                    payload = json.loads(observation.content[0].text)
                    assert payload['evidence']['argv'] == ['command-token', 'exact', *ARGS], payload
                    result.update(status='pass', argv=payload['evidence']['argv'])
    except Exception as exc:
        result.update(status='error', errors=errors(exc))
    print(json.dumps(result), flush=True)
    return result

async def main():
    print(json.dumps({'client': 'Official Python MCP SDK', 'mcp': importlib.metadata.version('mcp'), 'python': platform.python_version(), 'platform': platform.platform(), 'PATHEXT': os.environ.get('PATHEXT')}), flush=True)
    source = Path(__file__).resolve().parents[2] / 'plugins' / 'agent-plugins-conformance-core'
    with tempfile.TemporaryDirectory(prefix='apc launch evidence ') as parent:
        root = Path(parent) / 'installed plugin with spaces'
        shutil.copytree(source, root)
        direct = await attempt(root, 'probe token.cmd')
        await attempt(root, 'probe token')
        (root / 'bin' / 'probe token').unlink()
        print(json.dumps({'control': 'extensionless file removed; cmd companion retained'}), flush=True)
        await attempt(root, 'probe token')
        assert direct['status'] == 'pass', 'Explicit .cmd control failed; comparison is inconclusive'

asyncio.run(main())
