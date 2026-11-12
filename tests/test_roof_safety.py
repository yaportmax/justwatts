from conftest import REPO, run_node


def test_generated_roofs_fit_their_walls_and_height(node):
    result = run_node(node, REPO / 'tests' / 'js' / 'roof_safety.mjs')
    assert result['cases'] == 8
    assert result['faces'] > 0
