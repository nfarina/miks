import { colors } from "crosswing/colors";
import { fonts } from "crosswing/fonts";
import { Check } from "lucide-react";
import type { AskAnswers, AskQuestion } from "miks/shared/protocol";
import { useState } from "react";
import { styled } from "styled-components";

/** What's picked for one question: options by label, your own words, a note. */
type Pick = { labels: string[]; other: string | null; note: string | null };

const EMPTY: Pick = { labels: [], other: null, note: null };

/**
 * Questions the agent asked (Claude Code's AskUserQuestion), as a card: its
 * options to pick from, your own words instead ("Other", as the terminal
 * offers), and a note to go with an answer. Answerable while `onAnswer` is
 * given (the daemon holds its hook: `Tab.asking`); answered, it shows what
 * was picked, wherever that was.
 */
export function Questions({
  questions,
  answered,
  onAnswer,
}: {
  questions: AskQuestion[];
  answered?: AskAnswers;
  /** Given while this is what's being asked, and can be answered from here. */
  onAnswer?: (answers: AskAnswers) => void;
}) {
  const [picks, setPicks] = useState<Pick[]>(() => questions.map(() => EMPTY));
  const [sent, setSent] = useState(false);
  const live = !!onAnswer && !answered && !sent;

  const update = (index: number, change: (pick: Pick) => Pick) =>
    setPicks((current) => current.map((pick, i) => (i === index ? change(pick) : pick)));

  const answerFor = (question: AskQuestion, pick: Pick): string | string[] | null => {
    const other = pick.other?.trim();
    if (question.multiSelect) {
      const all = [...pick.labels, ...(other ? [other] : [])];
      return all.length > 0 ? all : null;
    }
    return other || pick.labels[0] || null;
  };

  const ready = questions.every((question, index) => answerFor(question, picks[index]) !== null);

  function submit() {
    if (!live || !ready) return;
    const answers: AskAnswers["answers"] = {};
    const notes: Record<string, string> = {};
    questions.forEach((question, index) => {
      answers[question.question] = answerFor(question, picks[index])!;
      const note = picks[index].note?.trim();
      if (note) notes[question.question] = note;
    });
    setSent(true);
    onAnswer!({ answers, ...(Object.keys(notes).length > 0 && { notes }) });
  }

  return (
    <StyledQuestions data-live={live}>
      {questions.map((question, index) => {
        const pick = picks[index];
        // Answered: what was picked, by label, and anything else was your own words.
        const given = answered?.answers[question.question];
        const labels = new Set(question.options.map((option) => option.label));
        const givenList = given === undefined ? [] : Array.isArray(given) ? given : splitPicks(question, given, labels);
        const chosen = (label: string) => (answered ? givenList.includes(label) : pick.labels.includes(label));
        const ownWords = answered ? givenList.filter((each) => !labels.has(each)).join(", ") : null;
        const note = answered?.notes?.[question.question];
        const preview = question.options.find((option) => chosen(option.label) && option.preview)?.preview;

        return (
          <div key={question.question} className="question">
            {question.header && <div className="header">{question.header}</div>}
            <div className="text">{question.question}</div>
            <div className="options" role={question.multiSelect ? "group" : "radiogroup"}>
              {question.options.map((option) => (
                <button
                  key={option.label}
                  className="option"
                  role={question.multiSelect ? "checkbox" : "radio"}
                  aria-checked={chosen(option.label)}
                  data-chosen={chosen(option.label)}
                  disabled={!live}
                  onClick={() =>
                    update(index, (current) => ({
                      ...current,
                      labels: question.multiSelect
                        ? current.labels.includes(option.label)
                          ? current.labels.filter((label) => label !== option.label)
                          : [...current.labels, option.label]
                        : [option.label],
                      // One answer: an option, or your own words.
                      other: question.multiSelect ? current.other : null,
                    }))
                  }
                >
                  <span className="mark" data-multi={!!question.multiSelect}>
                    {chosen(option.label) && <Check size={11} strokeWidth={3} />}
                  </span>
                  <span className="body">
                    <span className="label">{option.label}</span>
                    {option.description && option.description !== option.label && (
                      <span className="description">{option.description}</span>
                    )}
                  </span>
                </button>
              ))}
              {live && (
                <input
                  className="other"
                  placeholder={question.multiSelect ? "Something else" : "Or say something else"}
                  value={pick.other ?? ""}
                  onChange={(event) => {
                    const other = event.target.value;
                    update(index, (current) => ({
                      ...current,
                      other,
                      labels: question.multiSelect || !other.trim() ? current.labels : [],
                    }));
                  }}
                  onKeyDown={(event) => event.key === "Enter" && submit()}
                />
              )}
              {ownWords && <div className="own-words">“{ownWords}”</div>}
            </div>
            {preview && <pre className="preview">{preview}</pre>}
            {live &&
              (pick.note === null ? (
                <button className="add-note" onClick={() => update(index, (current) => ({ ...current, note: "" }))}>
                  Add a note
                </button>
              ) : (
                <textarea
                  className="note"
                  rows={2}
                  placeholder="A note to go with your answer"
                  value={pick.note}
                  // Opened by hand: the keyboard goes to it.
                  autoFocus
                  onChange={(event) => {
                    const note = event.target.value;
                    update(index, (current) => ({ ...current, note }));
                  }}
                />
              ))}
            {note && <div className="given-note">{note}</div>}
          </div>
        );
      })}
      {live && (
        <button className="submit" disabled={!ready} onClick={submit}>
          {questions.length > 1 ? "Send answers" : "Send answer"}
        </button>
      )}
      {sent && !answered && <div className="status">Sending…</div>}
      {!onAnswer && !answered && !sent && <div className="status">Answer in the terminal.</div>}
      {answered && Object.keys(answered.answers).length === 0 && <div className="status">Not answered.</div>}
    </StyledQuestions>
  );
}

/**
 * Several options picked come back from Claude Code as one string, their
 * labels joined by ", " (as a real transcript had them), unless they're
 * your own words.
 */
function splitPicks(question: AskQuestion, given: string, labels: Set<string>): string[] {
  if (!question.multiSelect || labels.has(given)) return [given];
  const parts = given.split(", ");
  return parts.every((part) => labels.has(part)) ? parts : [given];
}

export const StyledQuestions = styled.div`
  display: flex;
  flex-flow: column;
  gap: 14px;
  padding: 12px 14px;
  border: 1px solid ${colors.separator()};
  border-radius: 12px;
  background: ${colors.textBackground()};

  > .question {
    display: flex;
    flex-flow: column;
    gap: 6px;

    > .header {
      color: ${colors.textSecondary()};
      font: ${fonts.displayBold({ size: 11, line: "14px" })};
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    > .text {
      font: ${fonts.displayMedium({ size: 14, line: "20px" })};
      overflow-wrap: anywhere;
      white-space: pre-wrap;
    }

    > .options {
      display: flex;
      flex-flow: column;
      gap: 4px;

      > .option {
        display: flex;
        align-items: flex-start;
        gap: 9px;
        padding: 7px 10px;
        border: 1px solid ${colors.separator()};
        border-radius: 8px;
        background: none;
        color: inherit;
        font: inherit;
        text-align: left;
        cursor: pointer;

        &:not(:disabled):hover {
          border-color: ${colors.textSecondary({ alpha: 0.5 })};
        }

        &:disabled {
          cursor: default;
        }

        &[data-chosen="true"] {
          border-color: ${colors.darkBlue()};
          background: ${colors.darkBlue({ alpha: 0.08 })};
        }

        > .mark {
          flex-shrink: 0;
          width: 15px;
          height: 15px;
          margin-top: 2px;
          display: flex;
          align-items: center;
          justify-content: center;
          border: 1.5px solid ${colors.textSecondary({ alpha: 0.6 })};
          border-radius: 50%;
          color: ${colors.white()};

          &[data-multi="true"] {
            border-radius: 4px;
          }
        }

        &[data-chosen="true"] > .mark {
          border-color: ${colors.darkBlue()};
          background: ${colors.darkBlue()};
        }

        > .body {
          min-width: 0;
          display: flex;
          flex-flow: column;
          overflow-wrap: anywhere;

          > .label {
            font: ${fonts.displayMedium({ size: 13, line: "19px" })};
          }

          > .description {
            color: ${colors.textSecondary()};
            font: ${fonts.display({ size: 12, line: "17px" })};
          }
        }
      }

      > .other {
        padding: 7px 10px;
        border: 1px solid ${colors.separator()};
        border-radius: 8px;
        background: none;
        color: inherit;
        font: ${fonts.display({ size: 13, line: "19px" })};
        outline: none;

        &:focus {
          border-color: ${colors.darkBlue()};
        }
      }

      > .own-words {
        padding: 2px 10px;
        font: ${fonts.displayMedium({ size: 13, line: "19px" })};
        overflow-wrap: anywhere;
      }
    }

    > .preview {
      margin: 0;
      padding: 8px 10px;
      max-height: 240px;
      overflow: auto;
      border-radius: 6px;
      background: ${colors.textBackgroundPanel()};
      border: 1px solid ${colors.separator()};
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font: ${fonts.displayMono({ size: 11.5, line: "16px" })};
    }

    > .add-note {
      align-self: flex-start;
      padding: 0;
      border: none;
      background: none;
      color: ${colors.textSecondary()};
      font: ${fonts.display({ size: 12, line: "18px" })};
      cursor: pointer;

      &:hover {
        color: ${colors.text()};
      }
    }

    > .note {
      resize: vertical;
      padding: 7px 10px;
      border: 1px solid ${colors.separator()};
      border-radius: 8px;
      background: none;
      color: inherit;
      font: ${fonts.display({ size: 13, line: "19px" })};
      outline: none;

      &:focus {
        border-color: ${colors.darkBlue()};
      }
    }

    > .given-note {
      padding-left: 10px;
      border-left: 2px solid ${colors.separator()};
      color: ${colors.textSecondary()};
      font: ${fonts.display({ size: 12, line: "18px" })};
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
  }

  > .submit {
    align-self: flex-end;
    padding: 6px 14px;
    border: none;
    border-radius: 999px;
    background: ${colors.darkBlue()};
    color: ${colors.white()};
    font: ${fonts.displayMedium({ size: 13, line: "19px" })};
    cursor: pointer;

    &:disabled {
      opacity: 0.4;
      cursor: default;
    }
  }

  > .status {
    color: ${colors.textSecondary()};
    font: ${fonts.display({ size: 12, line: "18px" })};
  }
`;
