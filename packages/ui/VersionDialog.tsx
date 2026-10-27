import { colors } from "crosswing/colors";
import { fonts } from "crosswing/fonts";
import { DialogView } from "crosswing/modals/dialog";
import { type Build, type ClientInfo, PROTOCOL_VERSION, type VersionInfo } from "miks/shared/protocol";
import { ago, buildLabel, clientKind, installedChanged, windowHere, windowNotes } from "miks/shared/version";
import { type ReactNode, useEffect, useState } from "react";
import { styled } from "styled-components";
import { clientInfo } from "./client";
import { daemon, useDaemon, useTarget } from "./daemon";

/**
 * What `miks version` says, from the version warning: the daemon, what's
 * installed on its Mac, this window and the others. An older daemon can't
 * say, so then it's only this window, and the protocols the two speak.
 */
export function VersionDialog({ onClose }: { onClose: () => void }) {
  const { state } = useDaemon();
  const target = useTarget();
  // Undefined while asking.
  const [info, setInfo] = useState<VersionInfo | null>();

  useEffect(() => {
    void daemon.version().then(setInfo);
  }, []);

  return (
    <DialogView title="Versions" onClose={onClose} form={false} buttons={[{ title: "Done", primary: true, onClick: onClose }]}>
      <StyledVersionDialog>
        {info === undefined ? null : info ? (
          <Report info={info} />
        ) : (
          <>
            <Section heading="Daemon" color={colors.turquoiseDark()} on={target?.name ?? null}>
              <p>
                It speaks protocol {state?.protocol ?? 1}, and this window {PROTOCOL_VERSION}.{" "}
                {(state?.protocol ?? 1) < PROTOCOL_VERSION
                  ? "It's from an older Miks, which can't say more: restart it to run what's installed on its Mac, or update Miks there."
                  : (state?.protocol ?? 1) > PROTOCOL_VERSION
                    ? "It's from a newer Miks: update this one."
                    : "It didn't answer."}
              </p>
            </Section>
            <Section heading="This window" color={colors.green()} on={clientInfo().machine}>
              <Window client={clientInfo()} running={null} machine={null} />
            </Section>
          </>
        )}
      </StyledVersionDialog>
    </DialogView>
  );
}

function Report({ info }: { info: VersionInfo }) {
  const { machine, running, installed, windows } = info;
  const you = windows.find((w) => w.you);
  const others = windows.filter((w) => !w.you);

  return (
    <>
      <Section heading="Daemon" color={colors.turquoiseDark()} on={machine}>
        <BuildLine build={running} />
        <p className="secondary">
          Protocol {info.protocol}, pid {info.pid}, up since <When iso={info.started} />
        </p>
      </Section>
      <Section heading="Installed" color={colors.purple()} on={machine} detail={installed.at}>
        <BuildLine build={installed} />
        {installedChanged(info) ? (
          <p className="warning">Not what the daemon runs: it runs this once restarted (Miks → Restart daemon…).</p>
        ) : (
          <p className="secondary">Same as the daemon.</p>
        )}
        {!windowHere(info) && <p className="secondary">No Miks window open on this Mac.</p>}
      </Section>
      {you && (
        <Section heading="This window" color={colors.green()}>
          <Window client={you.client} running={running} machine={machine} />
        </Section>
      )}
      {others.length > 0 && (
        <Section heading="Also connected" color={colors.darkBlue()}>
          {others.map((w, index) => (
            <Window key={index} client={w.client} running={running} machine={machine} />
          ))}
        </Section>
      )}
    </>
  );
}

function Section({ heading, color, on, detail, children }: { heading: string; color: string; on?: string | null; detail?: string; children: ReactNode }) {
  return (
    <section style={{ "--section-color": color } as any}>
      <h3>
        <span className="heading">{heading}</span>
        {on && (
          <>
            {" "}
            on <strong>{on}</strong>
          </>
        )}
        {detail && <span className="secondary"> {detail}</span>}
      </h3>
      {children}
    </section>
  );
}

/** A window and its UI's build; `machine` (the daemon's) and `running` for what to say beside them. */
function Window({ client, running, machine }: { client: ClientInfo | null; running: Build | null; machine: string | null }) {
  if (!client) return <p className="secondary">An older Miks, which doesn't say which it is</p>;
  const notes = machine ? windowNotes(client, machine) : [];
  return (
    <div className="window">
      <p>
        {clientKind(client)} on <strong>{client.machine}</strong>
        {notes.length > 0 && <span className="secondary"> {notes.join(", ")}</span>}
      </p>
      <BuildLine build={client.ui} dev={client.ui.dev} label={buildLabel(client)} same={!!client.ui.commit && client.ui.commit === running?.commit} />
    </div>
  );
}

function BuildLine({ build, dev, label = "Miks", same }: { build: Build; dev?: boolean; label?: string; same?: boolean }) {
  return (
    <p className="build">
      <span>
        {label} <strong>{build.version}</strong>
      </span>
      {build.commit && <code>{build.commit}</code>}
      {dev ? (
        <span className="secondary">dev server</span>
      ) : build.built ? (
        <span>
          built <When iso={build.built} />
        </span>
      ) : (
        <span className="secondary">from source</span>
      )}
      {same && <span className="secondary">same as the daemon</span>}
    </p>
  );
}

function When({ iso }: { iso: string }) {
  const date = new Date(iso);
  return (
    <>
      {date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}{" "}
      <span className="secondary">({ago(date)})</span>
    </>
  );
}

export const StyledVersionDialog = styled.div`
  display: flex;
  flex-flow: column;
  gap: 18px;
  padding: 0 var(--dialog-padding, 20px) 4px;
  max-width: 560px;
  font: ${fonts.display({ size: 14, line: "20px" })};
  color: ${colors.text()};

  > section {
    display: flex;
    flex-flow: column;
    gap: 4px;
    padding-left: 12px;
    border-left: 3px solid var(--section-color);

    > h3 {
      margin: 0 0 2px;
      font: ${fonts.display({ size: 14, line: "20px" })};

      > .heading {
        font: ${fonts.displayBold({ size: 14, line: "20px" })};
        color: var(--section-color);
      }
    }

    p {
      margin: 0;
    }

    > .window + .window {
      margin-top: 8px;
    }
  }

  strong {
    font: ${fonts.displayBold({ size: 14, line: "20px" })};
  }

  .secondary {
    color: ${colors.textSecondary()};
  }

  .warning {
    color: ${colors.orange()};
  }

  .build {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    column-gap: 10px;

    > code {
      font: ${fonts.displayMono({ size: 12 })};
      padding: 1px 5px;
      border-radius: 4px;
      background: ${colors.separator()};
    }
  }
`;
