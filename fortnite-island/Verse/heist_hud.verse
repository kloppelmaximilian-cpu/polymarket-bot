# Sky Heist - per-player HUD built with Verse UI.
#
# Layout (non-interactive, never captures input):
#   top centre : round phase + timer + active event
#   left side  : level / title, XP, bag, team vault, three daily contracts
#
# Every setter only changes text, so callers can update a single line when
# its value changes instead of rebuilding the widget tree.

using { /Fortnite.com/UI }
using { /UnrealEngine.com/Temporary/UI }
using { /UnrealEngine.com/Temporary/SpatialMath }
using { /Verse.org/Colors }
using { /Verse.org/Simulation }

HudText<localizes>(Text:string):message = "{Text}"

heist_hud := class:
    Player:player

    var MaybeRoot:?canvas = false

    PhaseBlock:text_block = text_block{DefaultTextColor := NamedColors.White, DefaultJustification := text_justification.Center}
    LevelBlock:text_block = text_block{DefaultTextColor := NamedColors.Gold}
    XPBlock:text_block = text_block{DefaultTextColor := NamedColors.White}
    BagBlock:text_block = text_block{DefaultTextColor := NamedColors.White}
    VaultBlock:text_block = text_block{DefaultTextColor := NamedColors.Cyan}
    ContractHeader:text_block = text_block{DefaultTextColor := NamedColors.Gold}
    ContractBlock0:text_block = text_block{DefaultTextColor := NamedColors.White}
    ContractBlock1:text_block = text_block{DefaultTextColor := NamedColors.White}
    ContractBlock2:text_block = text_block{DefaultTextColor := NamedColors.White}

    Show():void =
        if (not MaybeRoot?, PlayerUI := GetPlayerUI[Player]):
            Panel:stack_box = stack_box{Orientation := orientation.Vertical}
            Panel.AddWidget(stack_box_slot{Widget := LevelBlock, HorizontalAlignment := horizontal_alignment.Left})
            Panel.AddWidget(stack_box_slot{Widget := XPBlock, HorizontalAlignment := horizontal_alignment.Left})
            Panel.AddWidget(stack_box_slot{Widget := BagBlock, HorizontalAlignment := horizontal_alignment.Left})
            Panel.AddWidget(stack_box_slot{Widget := VaultBlock, HorizontalAlignment := horizontal_alignment.Left})
            Panel.AddWidget(stack_box_slot{Widget := ContractHeader, HorizontalAlignment := horizontal_alignment.Left})
            Panel.AddWidget(stack_box_slot{Widget := ContractBlock0, HorizontalAlignment := horizontal_alignment.Left})
            Panel.AddWidget(stack_box_slot{Widget := ContractBlock1, HorizontalAlignment := horizontal_alignment.Left})
            Panel.AddWidget(stack_box_slot{Widget := ContractBlock2, HorizontalAlignment := horizontal_alignment.Left})

            Root:canvas = canvas{}
            Root.AddWidget(canvas_slot{Anchors := anchors{Minimum := vector2{X := 0.015, Y := 0.30}, Maximum := vector2{X := 0.015, Y := 0.30}}, Alignment := vector2{X := 0.0, Y := 0.0}, SizeToContent := true, Widget := Panel})
            Root.AddWidget(canvas_slot{Anchors := anchors{Minimum := vector2{X := 0.5, Y := 0.07}, Maximum := vector2{X := 0.5, Y := 0.07}}, Alignment := vector2{X := 0.5, Y := 0.0}, SizeToContent := true, Widget := PhaseBlock})
            PlayerUI.AddWidget(Root, player_ui_slot{InputMode := ui_input_mode.None})
            set MaybeRoot = option{Root}

    Hide():void =
        if (Root := MaybeRoot?, PlayerUI := GetPlayerUI[Player]):
            PlayerUI.RemoveWidget(Root)
        set MaybeRoot = false

    SetPhase(Text:string):void =
        PhaseBlock.SetText(HudText(Text))

    SetLevel(Level:int, Title:string, XPIntoLevel:int, XPForNext:int):void =
        LevelBlock.SetText(HudText("LEVEL {Level}  {Title}"))
        if (XPForNext > 0):
            XPBlock.SetText(HudText("XP {XPIntoLevel} / {XPForNext}"))
        else:
            XPBlock.SetText(HudText("MAX LEVEL"))

    SetBag(Carried:int, Capacity:int):void =
        BagBlock.SetText(HudText("BAG {Carried} / {Capacity}"))
        if (Carried >= Capacity):
            BagBlock.SetTextColor(NamedColors.Orange)
        else:
            BagBlock.SetTextColor(NamedColors.White)

    SetVault(TeamName:string, Banked:int):void =
        VaultBlock.SetText(HudText("{TeamName} VAULT {Banked}"))

    SetContracts(Lines:[]string):void =
        ContractHeader.SetText(HudText("DAILY CONTRACTS"))
        if (Line0 := Lines[0]):
            ContractBlock0.SetText(HudText(Line0))
        if (Line1 := Lines[1]):
            ContractBlock1.SetText(HudText(Line1))
        if (Line2 := Lines[2]):
            ContractBlock2.SetText(HudText(Line2))
