(Spindle tramming complete measurement sequence)
(Radius 50 mm 4 moves of 90 degrees)
(Manually position at the selected start spindle power off)
(Edge2 initial pause compatibility retain the setup blocks)
G21
G17
G90
G94
G4 P0
G4 P0
G4 P0
G4 P0
G4 P0
G4 P0
G4 P0
M0 ;Reading 0 of 4 EAST record starting dial reading. Resume for move 1.
(Move 1 of 4 east to south clockwise)
G21 G17 G91 G94
G2 X-50.0000 Y-50.0000 I-50.0000 J0.0000 F300.0000
G4 P0
G90
M0 ;Reading 1 of 4 SOUTH record dial reading. Resume for move 2.
(Move 2 of 4 south to west clockwise)
G21 G17 G91 G94
G2 X-50.0000 Y50.0000 I0.0000 J50.0000 F300.0000
G4 P0
G90
M0 ;Reading 2 of 4 WEST record dial reading. Resume for move 3.
(Move 3 of 4 west to north clockwise)
G21 G17 G91 G94
G2 X50.0000 Y50.0000 I50.0000 J0.0000 F300.0000
G4 P0
G90
M0 ;Reading 3 of 4 NORTH record dial reading. Resume for move 4.
(Move 4 of 4 north to east clockwise)
G21 G17 G91 G94
G2 X50.0000 Y-50.0000 I0.0000 J-50.0000 F300.0000
G4 P0
G90
M0 ;Reading 4 of 4 EAST record dial reading. Sequence complete. Resume to end program.
G90
M2
