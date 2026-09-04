import { NextResponse } from "next/server";
import { getSettings } from "@/lib/localDb";
import { DEFAULT_HEADROOM_URL, getHeadroomStatus } from "@/lib/headroom/detect";
import { getManagedPid } from "@/lib/headroom/process";

export const dynamic = "force-dynamic";

// Copyable command for the dashboard's initial headroom install.
// Mirrors pkgManager(): uv tool install when uv is present, else pip.
function installHint(packageManager) {
  if (packageManager === "uv") {
    return { installHint: 'uv tool install "headroom-ai[proxy]"' };
  }
  return { installHint: 'pip install "headroom-ai[proxy]"' };
}

export async function GET() {
  try {
    const settings = await getSettings();
    const url = settings.headroomUrl || DEFAULT_HEADROOM_URL;
    const status = await getHeadroomStatus(url);
    const managedPid = getManagedPid();
    return NextResponse.json({ ...status, url, managedPid, ...installHint(status.packageManager) });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
