"""
Selects the main-experiment stimuli (20 concepts x 4 good + 4 bad labels) from the
Experiment 2 stimulus set and copies the images into the jsPsych folder.

Selection logic (same ranking as the Exp2 selection in generate_stimuli_list.py):
  - start from the 50 Exp2 concepts (01_pre_study_labels/04_stimuli_for_Exp2/selected_stimuli.csv)
  - drop concepts with a mean ease-of-naming difficulty >= MAX_DIFFICULTY
  - take the N_CONCEPTS concepts whose best label has the highest SigLIP2 cosine
  - keep the same 4 good and 4 bad labels per concept as in Exp2, ordered by cosine
    (good1 = highest cosine)

DATA STAGE NOTICE: based on the Exp1 pilot only, and Exp2 (goodness ratings) has not
been run yet. Once the Exp2 ratings are in, the good/bad split should come from the
human ratings instead of the SigLIP2 cosines - re-run this script then.

Outputs (in ../01_jspsych_main_social/stimuli/):
  concepts.csv     one row per concept - read by the experiment
  labels_long.csv  one row per concept x label, with cosine, novelty and check flags
  pictures/        the 20 images

Run with the pilot analysis venv's python:
  ..\\..\\01_pre_study_labels\\02_analysis_Exp1_labels\\01_pilot\\.venv\\Scripts\\python select_stimuli_main.py
"""

import shutil
import subprocess
import sys
from pathlib import Path

import pandas as pd

N_CONCEPTS = 20
MAX_DIFFICULTY = 50
N_GOOD = 4
N_BAD = 4

HERE = Path(__file__).parent                       # 03_main_experiment_social_factors/00_stimuli_selection/
SOCIAL = HERE.parent.parent                        # 02_social factors/
EXP2_SELECTION = SOCIAL / "01_pre_study_labels" / "04_stimuli_for_Exp2" / "selected_stimuli.csv"
EXP2_PICTURES = SOCIAL / "02_pre_study_goodness_ratings" / "01_jspsych_Exp2_goodness_ratings" / "stimuli" / "pictures"
OUT = HERE.parent / "01_jspsych_main_social" / "stimuli"


def main():
    labels = pd.read_csv(EXP2_SELECTION)

    concepts = (labels.groupby("concept_id")
                .agg(image=("picture", "first"),
                     difficulty_mean=("difficulty_mean", "first"),
                     best_cosine=("best_cosine", "first"))
                .reset_index())
    concepts = (concepts[concepts.difficulty_mean < MAX_DIFFICULTY]
                .sort_values("best_cosine", ascending=False)
                .head(N_CONCEPTS))
    if len(concepts) < N_CONCEPTS:
        raise SystemExit(f"only {len(concepts)} concepts below difficulty {MAX_DIFFICULTY}")

    labels = labels[labels.concept_id.isin(concepts.concept_id)].copy()
    labels = labels.sort_values(["concept_id", "label_type", "similarity"], ascending=[True, False, False])
    labels["label_rank"] = labels.groupby(["concept_id", "label_type"]).cumcount() + 1
    labels["label_slot"] = labels.label_type + labels.label_rank.astype(str)

    counts = labels.groupby(["concept_id", "label_type"]).size().unstack()
    if not ((counts["good"] == N_GOOD) & (counts["bad"] == N_BAD)).all():
        raise SystemExit(f"not every concept has {N_GOOD} good and {N_BAD} bad labels:\n{counts}")

    slots = [f"good{i}" for i in range(1, N_GOOD + 1)] + [f"bad{i}" for i in range(1, N_BAD + 1)]
    wide = labels.pivot(index="concept_id", columns="label_slot", values="label")[slots].reset_index()
    flagged = (labels[labels.check.notna()].groupby("concept_id").label
               .apply(lambda s: ";".join(s)).rename("labels_to_check"))
    wide = (concepts.merge(wide, on="concept_id")
            .merge(flagged, on="concept_id", how="left"))
    wide.insert(0, "concept_nr", range(1, len(wide) + 1))
    wide["labels_to_check"] = wide["labels_to_check"].fillna("")

    (OUT / "pictures").mkdir(parents=True, exist_ok=True)
    wide.to_csv(OUT / "concepts.csv", index=False, encoding="utf-8")
    subprocess.run([sys.executable, str(OUT.parent / "tools" / "build_local_stimuli.py")], check=True)
    labels[["concept_id", "picture", "label_slot", "label_type", "label",
            "similarity", "novelty", "produced_as", "n_participants", "check"]] \
        .rename(columns={"picture": "image", "similarity": "siglip_cosine"}) \
        .to_csv(OUT / "labels_long.csv", index=False, encoding="utf-8")
    for image in wide.image:
        shutil.copy2(EXP2_PICTURES / image, OUT / "pictures" / image)

    print(wide[["concept_nr", "concept_id", "image", "difficulty_mean", "best_cosine"] + slots].to_string(index=False))
    print(f"\nwrote {len(wide)} concepts to {OUT}")


if __name__ == "__main__":
    main()
