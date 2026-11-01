# Graph edge clearance

Graph layout first computes force or tree positions. The force simulation repels nodes
from nonincident edges as well as from other nodes to retain compact layouts. It then
separates every nonincident centre-to-centre edge from each node's circumscribed radius
plus 6 pixels, reserving the maximum parallel-edge bend, self-loop reach and arrowhead
width as well. It scales positions uniformly; if a general graph would require more than
3× scaling (including collinearity), it uses a deterministic convex polygon before
scaling. Distinct vertices on a circle cannot lie on a chord, so this produces finite
clearance even for dense graphs. General layouts that need scaling rotate to their
narrowest sampled axis to preserve phone space. The result can be large and require
scrolling, especially near the schema limits. It does not promise planar drawings,
uncrossed edges, or space between every edge label. Trees keep their ordering and levels.
Steps never affect the layout.
